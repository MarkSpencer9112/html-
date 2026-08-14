/* GraphWar core — canvas rendering, coordinate conversion, parser and turn flow. */
const CFG = Object.freeze({
  xMin: -12, xMax: 12, yMin: -8, yMax: 8, turnSeconds: 60,
  maxHp: 100, unitRadius: .58, projectileRadius: .16, projectileMs: 2500,
  minSeparation: 11, aiDelayMs: 1100,
  damage: { direct: 38, near: 25, graze: 12 },
  colors: { player: '#44aaff', enemy: '#ff4455' }
});

const $ = (s) => document.querySelector(s);
const D = {
  canvas: $('#gameCanvas'), title: $('#titleScreen'), game: $('#gameScreen'), result: $('#resultScreen'),
  input: $('#funcIn'), fire: $('#fireBtn'), preview: $('#previewBtn'), timer: $('#timerDisplay'),
  turnName: $('#turnName'), turnDot: $('#turnDot'), round: $('#roundInfo'), health: $('#healthBar'),
  status: $('#statusOv'), flash: $('#hitFlash'), help: $('#helpModal'), resultName: $('#winnerName'), resultSub: $('#winnerSub')
};
const ctx = D.canvas.getContext('2d');
const S = { phase: 'title', round: 1, turn: 'player', derivative: 0, player: null, enemy: null,
  expression: null, preview: null, projectile: null, timerId: null, time: CFG.turnSeconds, W: 0, H: 0, dpr: 1 };

// CoordinateSystem: math coordinates are the one source of truth; canvas y is inverted.
const Coord = {
  x: (v) => (v - CFG.xMin) / (CFG.xMax - CFG.xMin) * S.W,
  y: (v) => S.H - (v - CFG.yMin) / (CFG.yMax - CFG.yMin) * S.H,
  unitX: () => S.W / (CFG.xMax - CFG.xMin), unitY: () => S.H / (CFG.yMax - CFG.yMin)
};

// MathExpressionParser: a deliberately small tokenizer + recursive descent evaluator.
// It avoids executing player input as JavaScript and is easy to extend in FUNCTIONS.
const FUNCTIONS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs, sqrt: Math.sqrt,
  log: Math.log10 || ((x) => Math.log(x) / Math.LN10), ln: Math.log, exp: Math.exp };
class MathExpressionParser {
  parse(source) {
    let text = String(source || '').trim().toLowerCase().replace(/\s+/g, '');
    text = text.replace(/^(?:y|f\(x\))=/, '').replace(/π/g, 'pi');
    if (!text) throw new Error('请输入函数');
    const raw = this.tokenize(text); this.tokens = this.addImplicitMultiply(raw); this.at = 0;
    const node = this.sum();
    if (this.peek()) throw new Error(`无法识别 “${this.peek().value}”`);
    // Probe a few safe values to catch structural issues now, but domain gaps remain valid.
    [-1, 0, 1].forEach((x) => { try { this.evaluate(node, x); } catch (_) {} });
    return node;
  }
  tokenize(text) {
    const out = []; let i = 0;
    while (i < text.length) {
      const rest = text.slice(i), m = rest.match(/^(\d*\.\d+|\d+\.?\d*|[a-z]+|[+\-*/^()])/);
      if (!m) throw new Error(`第 ${i + 1} 个字符无效`);
      const value = m[0]; out.push({ type: /^\d/.test(value) ? 'num' : /^[a-z]+$/.test(value) ? 'id' : value, value }); i += value.length;
    }
    return out;
  }
  addImplicitMultiply(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const a = tokens[i], b = tokens[i + 1]; out.push(a);
      if (!b) continue;
      const left = a.type === 'num' || a.type === 'id' || a.type === ')';
      const right = b.type === 'num' || b.type === 'id' || b.type === '(';
      // A known function immediately followed by '(' is a call, not multiplication.
      if (left && right && !(a.type === 'id' && FUNCTIONS[a.value] && b.type === '(')) out.push({ type: '*', value: '*' });
    }
    return out;
  }
  peek() { return this.tokens[this.at]; }
  take(type) { if (this.peek()?.type === type) return this.tokens[this.at++]; return null; }
  sum() { let n = this.product(); for (;;) { const op = this.take('+') || this.take('-'); if (!op) return n; n = { k: 'bin', op: op.value, a: n, b: this.product() }; } }
  product() { let n = this.power(); for (;;) { const op = this.take('*') || this.take('/'); if (!op) return n; n = { k: 'bin', op: op.value, a: n, b: this.power() }; } }
  power() { let n = this.unary(); if (this.take('^')) n = { k: 'bin', op: '^', a: n, b: this.power() }; return n; }
  unary() { if (this.take('+')) return this.unary(); if (this.take('-')) return { k: 'neg', a: this.unary() }; return this.atom(); }
  atom() {
    const num = this.take('num'); if (num) return { k: 'num', n: Number(num.value) };
    const id = this.take('id');
    if (id) {
      if (id.value === 'x') return { k: 'x' }; if (id.value === 'pi') return { k: 'num', n: Math.PI }; if (id.value === 'e') return { k: 'num', n: Math.E };
      if (!FUNCTIONS[id.value]) throw new Error(`不支持函数 ${id.value}`);
      if (!this.take('(')) throw new Error(`${id.value} 后需要括号`);
      const a = this.sum(); if (!this.take(')')) throw new Error('缺少右括号'); return { k: 'fn', fn: id.value, a };
    }
    if (this.take('(')) { const n = this.sum(); if (!this.take(')')) throw new Error('缺少右括号'); return n; }
    throw new Error('需要数字、x 或括号');
  }
  evaluate(n, x) {
    let v;
    if (n.k === 'num') v = n.n; else if (n.k === 'x') v = x; else if (n.k === 'neg') v = -this.evaluate(n.a, x);
    else if (n.k === 'fn') v = FUNCTIONS[n.fn](this.evaluate(n.a, x));
    else { const a = this.evaluate(n.a, x), b = this.evaluate(n.b, x); v = n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a ** b; }
    return Number.isFinite(v) ? v : NaN;
  }
  derivative(ast, x, order) {
    const h = .002;
    if (order === 0) return this.evaluate(ast, x);
    if (order === 1) return (this.evaluate(ast, x + h) - this.evaluate(ast, x - h)) / (2 * h);
    return (this.evaluate(ast, x + h) - 2 * this.evaluate(ast, x) + this.evaluate(ast, x - h)) / (h * h);
  }
}
const Parser = new MathExpressionParser();

function resize() { const r = D.canvas.parentElement.getBoundingClientRect(); S.dpr = devicePixelRatio || 1; S.W = Math.max(1, Math.round(r.width)); S.H = Math.max(1, Math.round(r.height)); D.canvas.width = S.W * S.dpr; D.canvas.height = S.H * S.dpr; D.canvas.style.width = `${S.W}px`; D.canvas.style.height = `${S.H}px`; ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); render(); }
function random(min, max) { return min + Math.random() * (max - min); }
function makeCombatants() {
  const player = { name: '玩家', icon: '◆', color: CFG.colors.player, hp: CFG.maxHp, x: random(-9, -6), y: random(-5.5, 5.5), side: 1 };
  let enemy;
  do enemy = { name: '敌军', icon: '◆', color: CFG.colors.enemy, hp: CFG.maxHp, x: random(3, 9), y: random(-5.5, 5.5), side: -1 };
  while (Math.hypot(player.x - enemy.x, player.y - enemy.y) < CFG.minSeparation);
  return { player, enemy };
}
function startGame() { Object.assign(S, { phase: 'input', round: 1, turn: 'player', derivative: 0, expression: null, preview: null, projectile: null, ...makeCombatants() }); D.title.classList.add('hidden'); D.game.classList.remove('hidden'); D.result.classList.remove('show'); D.input.value = ''; setDerivative(0); resize(); updateUI(); startTimer(); showStatus('你的回合：输入函数后发射', CFG.colors.player); }
function updateUI() { const actor = S.turn === 'player' ? S.player : S.enemy; D.turnName.textContent = S.turn === 'player' ? '◆ 你的回合' : '◆ 敌军计算中'; D.turnName.style.color = actor.color; D.turnDot.style.background = actor.color; D.round.textContent = `回合 ${S.round}`; D.timer.textContent = String(S.time); D.input.disabled = S.phase !== 'input'; D.fire.disabled = S.phase !== 'input' || !S.expression; D.preview.disabled = S.phase !== 'input' || !S.expression; D.health.innerHTML = healthMarkup(S.player, true) + healthMarkup(S.enemy, false); }
function healthMarkup(unit, own) { const pct = Math.max(0, unit.hp / CFG.maxHp * 100); return `<div class="hp-item"><span class="nd" style="background:${unit.color}"></span><span>${own ? '你' : '敌'}</span><div class="hp-bar"><div class="hp-fill" style="width:${pct}%;background:${unit.color}"></div></div><span class="hp-txt">${unit.hp}</span></div>`; }
function setDerivative(v) { S.derivative = v; document.querySelectorAll('.deriv-btn[data-d]').forEach((b) => b.classList.toggle('active', Number(b.dataset.d) === v)); render(); }
function startTimer() { clearInterval(S.timerId); S.time = CFG.turnSeconds; updateUI(); S.timerId = setInterval(() => { if (S.phase !== 'input') return; S.time--; D.timer.textContent = String(Math.max(0, S.time)); if (S.time <= 0) { clearInterval(S.timerId); showStatus('⏰ 超时，回合结束', '#ffdd44'); setTimeout(endPlayerTurn, 700); } }, 1000); }
function parseInput() { try { S.expression = Parser.parse(D.input.value); S.preview = S.expression; D.input.style.borderColor = 'var(--border)'; updateUI(); render(); return true; } catch (err) { S.expression = null; S.preview = null; D.input.style.borderColor = '#ff4455'; showStatus(`函数解析错误：${err.message}`, '#ff7788'); updateUI(); render(); return false; } }
function localY(ast, localX, derivative) { return Parser.derivative(ast, localX, derivative); }
function trajectory(actor, ast, mode) { return (worldX) => actor.y + localY(ast, actor.side * (worldX - actor.x), mode); }
function preview() { if (parseInput()) { S.preview = S.expression; showStatus('已显示轨迹预览', '#b8b8ff'); } }
function firePlayer() { if (S.phase !== 'input' || !parseInput()) return; clearInterval(S.timerId); launch(S.player, S.enemy, S.expression, S.derivative); }
function aiTurn() {
  S.turn = 'enemy'; S.phase = 'ai'; S.preview = null; S.time = CFG.turnSeconds; updateUI(); render(); showStatus('敌军正在估算弹道…', CFG.colors.enemy);
  setTimeout(() => {
    if (S.phase !== 'ai') return;
    // Aim at an intentionally noisy estimate; a local straight-line function is valid GraphWar input.
    const guessedY = S.player.y + random(-1.55, 1.55), dx = Math.abs(S.player.x - S.enemy.x), slope = (guessedY - S.enemy.y) / dx;
    const ast = Parser.parse(`${slope}*x`); launch(S.enemy, S.player, ast, 0);
  }, CFG.aiDelayMs);
}
function launch(actor, target, ast, mode) { S.phase = 'flying'; S.preview = ast; S.projectile = { actor, target, ast, mode, started: 0, hit: false, closest: Infinity }; D.input.disabled = true; D.fire.disabled = true; D.preview.disabled = true; D.fire.textContent = '▶ 飞行中…'; requestAnimationFrame(animate); }
function animate(now) { const p = S.projectile; if (!p) return; if (!p.started) p.started = now; const t = Math.min(1, (now - p.started) / CFG.projectileMs), distance = p.actor.side === 1 ? CFG.xMax - p.actor.x : p.actor.x - CFG.xMin; const x = p.actor.x + p.actor.side * distance * t, y = trajectory(p.actor, p.ast, p.mode)(x); if (Number.isFinite(y)) { const d = Math.hypot(x - p.target.x, y - p.target.y); p.closest = Math.min(p.closest, d); if (!p.hit && d < CFG.unitRadius + CFG.projectileRadius) { p.hit = true; applyDamage(p.target, d); } } render(); if (t < 1 && !p.hit) requestAnimationFrame(animate); else finishShot(); }
function applyDamage(target, d) { const damage = d < .3 ? CFG.damage.direct : d < .65 ? CFG.damage.near : CFG.damage.graze; target.hp = Math.max(0, target.hp - damage); D.flash.style.background = `${target.color}55`; D.flash.style.opacity = '1'; setTimeout(() => D.flash.style.opacity = '0', 250); showStatus(`💥 命中 ${target.name}！-${damage} HP`, target.color); updateUI(); }
function finishShot() { const p = S.projectile; S.projectile = null; if (p.target.hp <= 0) return endGame(p.actor); if (!p.hit) showStatus('弹道未命中', '#86869d'); setTimeout(() => { if (p.actor === S.player) endPlayerTurn(); else beginPlayerTurn(); }, 1000); }
function endPlayerTurn() { if (S.player.hp <= 0 || S.enemy.hp <= 0) return; S.phase = 'transition'; S.preview = null; render(); aiTurn(); }
function beginPlayerTurn() { if (S.player.hp <= 0 || S.enemy.hp <= 0) return; S.turn = 'player'; S.phase = 'input'; S.round++; S.expression = null; S.preview = null; D.input.value = ''; D.fire.textContent = '🚀 发射'; D.input.style.borderColor = 'var(--border)'; updateUI(); startTimer(); render(); showStatus('你的回合：观察坐标轴并规划函数', CFG.colors.player); }
function endGame(winner) { clearInterval(S.timerId); S.phase = 'over'; D.result.classList.add('show'); D.resultName.textContent = winner === S.player ? '🏆 你获胜了！' : '💀 敌军获胜'; D.resultName.style.color = winner.color; D.resultSub.textContent = winner === S.player ? '函数计算精准命中。' : '再观察一下敌人的大致位置吧。'; }
function showStatus(text, color = '#fff') { D.status.textContent = text; D.status.style.color = color; D.status.classList.add('show'); clearTimeout(showStatus.id); showStatus.id = setTimeout(() => D.status.classList.remove('show'), 1500); }

function render() {
  if (!S.W || !S.H || !S.player) return; ctx.fillStyle = '#0a0a1a'; ctx.fillRect(0, 0, S.W, S.H); drawGrid();
  if (S.preview) drawCurve(S.turn === 'enemy' ? S.enemy : S.player, S.preview, S.derivative, S.turn === 'enemy' ? CFG.colors.enemy : CFG.colors.player, .32, null);
  if (S.projectile) { const p = S.projectile, elapsed = performance.now() - p.started, t = Math.min(1, elapsed / CFG.projectileMs); drawCurve(p.actor, p.ast, p.mode, p.actor.color, 1, t); }
  drawUnit(S.player, '玩家'); drawUnit(S.enemy, '敌军');
}
function drawGrid() { const fs = Math.max(9, Math.min(12, S.W / 65)); ctx.strokeStyle = '#171733'; ctx.lineWidth = 1; for (let x = CFG.xMin; x <= CFG.xMax; x++) line(Coord.x(x), 0, Coord.x(x), S.H); for (let y = CFG.yMin; y <= CFG.yMax; y++) line(0, Coord.y(y), S.W, Coord.y(y)); ctx.strokeStyle = '#414168'; ctx.lineWidth = 2; line(Coord.x(0), 0, Coord.x(0), S.H); line(0, Coord.y(0), S.W, Coord.y(0)); ctx.fillStyle = '#77779c'; ctx.font = `${fs}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; for (let x = -10; x <= 10; x += 2) if (x) ctx.fillText(x, Coord.x(x), Coord.y(0) + 4); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; for (let y = -6; y <= 6; y += 2) if (y) ctx.fillText(y, Coord.x(0) - 5, Coord.y(y)); ctx.fillStyle = '#a2a2c0'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('Y', Coord.x(0) - 6, 13); ctx.textAlign = 'right'; ctx.fillText('X', S.W - 8, Coord.y(0) - 5); }
function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function drawCurve(actor, ast, mode, color, alpha, progress) { const end = actor.side === 1 ? CFG.xMax : CFG.xMin, steps = 420, last = progress == null ? 1 : progress, fn = trajectory(actor, ast, mode); ctx.beginPath(); let open = false; for (let i = 0; i <= steps * last; i++) { const x = actor.x + (end - actor.x) * (i / steps), y = fn(x); if (!Number.isFinite(y) || Math.abs(y) > 100) { open = false; continue; } const px = Coord.x(x), py = Coord.y(y); if (!open) { ctx.moveTo(px, py); open = true; } else ctx.lineTo(px, py); } ctx.strokeStyle = `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`; ctx.lineWidth = progress == null ? 2 : 3; ctx.lineCap = 'round'; ctx.stroke(); if (progress != null) { const x = actor.x + (end - actor.x) * last, y = fn(x); if (Number.isFinite(y)) drawProjectile(x, y, color); } }
function drawProjectile(x, y, color) { const px = Coord.x(x), py = Coord.y(y), r = 6; const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4); g.addColorStop(0, '#fff'); g.addColorStop(.25, color); g.addColorStop(1, `${color}00`); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r * 4, 0, Math.PI * 2); ctx.fill(); }
function drawUnit(u, label) { const px = Coord.x(u.x), py = Coord.y(u.y), r = Math.max(9, S.W / 55), g = ctx.createRadialGradient(px, py, 0, px, py, r * 2.7); g.addColorStop(0, `${u.color}90`); g.addColorStop(1, `${u.color}00`); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r * 2.7, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = u.color; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff9'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fillStyle = '#e5e5f5'; ctx.font = `bold ${Math.max(10, S.W / 55)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(label, px, py - r - 4); }

function bind() {
  $('#startBtn').addEventListener('click', startGame); D.fire.addEventListener('click', firePlayer); D.preview.addEventListener('click', preview); D.input.addEventListener('input', () => { if (D.input.value.trim()) parseInput(); else { S.expression = null; S.preview = null; updateUI(); render(); } }); D.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') firePlayer(); }); document.querySelectorAll('.deriv-btn[data-d]').forEach((b) => b.addEventListener('click', () => { if (S.phase === 'input') setDerivative(Number(b.dataset.d)); })); $('#helpBtn').addEventListener('click', () => D.help.classList.add('show')); $('#closeHelpBtn').addEventListener('click', () => D.help.classList.remove('show')); D.help.addEventListener('click', (e) => { if (e.target === D.help) D.help.classList.remove('show'); }); $('#restartBtn').addEventListener('click', () => { D.result.classList.remove('show'); D.game.classList.add('hidden'); D.title.classList.remove('hidden'); S.phase = 'title'; }); window.addEventListener('resize', resize);
}
bind();
