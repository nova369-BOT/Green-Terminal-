/**
 * Automation panel — the strategy workbench.
 *
 * Layout logic: presets → edit rule → validate → backtest → robustness → deploy.
 * That ordering is deliberate and enforced in the UI: the deploy buttons render *after*
 * the evidence block, and the summary banner always shows the OOS verdict next to the
 * in-sample return, so "deploy first, test later" is awkward and "test then deploy" is
 * the path of least resistance.
 */
import { h, mount, patch, btn, field, numberInput, select, segmented, kv, hr, badge, empty, textInput } from './h.js';
import { state, set, toast } from '../modules/store.js';
import { fmtPrice, fmtMoney, fmtPct, fmtStamp, pad2 } from '../modules/fmt.js';
import { PRESETS, fromPreset, blank } from '../modules/presets.js';
import { ruleText, validateStrategy, CONDITION_OPS, VARS, PRICE_FIELDS, INDICATOR_SPECS } from '../modules/rule.js';
import { runBacktest, monteCarlo, walkForward, sensitivity, DEFAULT_RISK } from '../modules/backtest.js';
import { bars, universe } from '../modules/feed.js';
import { engine, deploy, undeploy, setMode, log } from '../modules/engine.js';
import { account, equity } from '../modules/broker.js';
import { drawEquity } from './chart.js';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1D'];
const DIRS = [
  { value: 'long', label: 'long only' },
  { value: 'short', label: 'short only' },
  { value: 'both', label: 'long + short (separate entry)' },
];
const SIZINGS = [
  { value: 'riskBudget', label: '% risk to stop (sized by stop distance)' },
  { value: 'equityPct', label: '% of equity (notional)' },
  { value: 'fixedQty', label: 'fixed quantity' },
];

export function createAutomation(host, ctx) {
  let tab = 'builder'; // builder | library | results | json
  const draft = { current: null, view: null, json: '', runState: 'idle', result: null, robust: null };

  const panel = h('div', { class: 'auto__body' });
  mount(host, h('div', { class: 'panel__head' }, h('h2', { text: 'AUTOMATION' }), h('span', { class: 'panel__hint', text: `${engine.deployed.size} deployed` })), panel);

  function ensureDraft() {
    if (draft.current) return draft.current;
    const p = PRESETS[0];
    draft.current = fromPreset(p, { symbol: state.symbol, tf: state.tf, id: `S${Date.now().toString().slice(-6)}` });
    syncFromDraft();
    return draft.current;
  }

  function syncFromDraft() {
    draft.json = JSON.stringify(draft.current, null, 2);
  }

  function render() {
    const s = ensureDraft();
    const errors = validateStrategy(s);
    mount(
      panel,
      h(
        'div',
        { class: 'auto__strats' },
        h('h3', { class: 'sec', text: 'DEPLOYED' }),
        engine.deployed.size
          ? h(
              'div',
              { class: 'auto__list' },
              ...[...engine.deployed.values()].map(({ strategy, rt }) => strategyCard(strategy, rt))
            )
          : empty('nothing running', 'configure below, backtest, then deploy in shadow mode first')
      ),
      segmented(
        [
          { id: 'builder', label: 'builder' },
          { id: 'library', label: 'library', badge: PRESETS.length },
          { id: 'results', label: 'research', badge: draft.result ? '✓' : null },
          { id: 'json', label: 'json' },
        ],
        tab,
        (id) => {
          tab = id;
          render();
        },
        { size: 'xs' }
      ),
      tab === 'builder' ? builder(s, errors) : null,
      tab === 'library' ? library() : null,
      tab === 'results' ? results(s) : null,
      tab === 'json' ? jsonEditor(errors) : null
    );
  }

  /* ------------------------------------------------------------------ cards */

  function strategyCard(strategy, rt) {
    const held = rt.positionId && account.positions.get(rt.positionId);
    return h(
      'div',
      { class: `scard scard--${strategy.mode}` },
      h(
        'div',
        { class: 'scard__top' },
        h('b', { class: 'scard__name', text: strategy.name }),
        badge(strategy.symbol, 'muted'),
        badge(strategy.tf, 'muted'),
        badge(strategy.direction, strategy.direction === 'short' ? 'down' : 'up'),
        h('span', { class: 'scard__spacer' }),
        segmented(
          [
            { id: 'shadow', label: 'shadow', title: 'evaluate and log, never trade' },
            { id: 'armed', label: 'armed', title: 'send to the paper broker' },
            { id: 'off', label: 'off' },
          ],
          strategy.mode,
          (m) => {
            setMode(strategy.id, m);
            render();
          },
          { size: 'xs' }
        )
      ),
      h('p', { class: 'scard__rule', text: ruleText(strategy.entry) }),
      strategy.exit ? h('p', { class: 'scard__rule scard__rule--exit', text: `exit: ${ruleText(strategy.exit)}` }) : null,
      h(
        'div',
        { class: 'scard__meta' },
        kv('bars seen', String(rt.barsEvaluated)),
        kv('signals', String(rt.hits)),
        kv('realised', fmtMoney(rt.realised, { compact: true })),
        kv('position', held ? `${held.side} ${fmtPrice(held.mark, strategy.meta?.tick)}` : 'flat'),
        rt.lastSignal ? kv('last', `${rt.lastSignal.side} ${fmtPrice(rt.lastSignal.price, 0.01)}`) : null
      ),
      h(
        'div',
        { class: 'scard__acts' },
        btn('load into builder', () => {
          draft.current = structuredClone(strategy);
          draft.current.id = strategy.id;
          syncFromDraft();
          tab = 'builder';
          render();
        }, { cls: 'xs' }),
        btn(ctx.runLabel(), () => {
          draft.current = structuredClone(strategy);
          syncFromDraft();
          run(draft.current, { quick: true });
        }, { cls: 'xs' }),
        btn('remove', () => {
          undeploy(strategy.id);
          render();
        }, { tone: 'danger', cls: 'xs' })
      )
    );
  }

  /* ------------------------------------------------------------------ builder */

  function builder(s, errors) {
    const setField = (patch) => {
      Object.assign(draft.current, patch);
      syncFromDraft();
      render();
    };
    const groups = viewFromRule(s.entry, s.entryLogic, s.entryGroups);

    const updateConds = (next) => {
      draft.current.entry = ruleFromView(next.logic, next.groups);
      draft.current.entryLogic = next.logic;
      draft.current.entryGroups = next.groups;
      draft.current.exit = s.exit ? s.exit : null;
      syncFromDraft();
      render();
    };

    return h(
      'div',
      { class: 'builder' },
      field('strategy name', textInput(s.name, (v) => setField({ name: v }))),
      h(
        'div',
        { class: 'grid2' },
        field(
          'instrument',
          select(s.symbol, universe().map((u) => ({ value: u.symbol, label: `${u.symbol} · ${u.label}` })), (v) => setField({ symbol: v }))
        ),
        field('timeframe', select(s.tf, TFS.map((t) => ({ value: t, label: t })), (v) => setField({ tf: v })))
      ),
      h(
        'div',
        { class: 'grid2' },
        field('direction', select(s.direction, DIRS, (v) => setField({ direction: v }))),
        field(
          'entry logic',
          segmented(
            [
              { id: 'all', label: 'ALL groups' },
              { id: 'any', label: 'ANY group' },
            ],
            s.entryLogic ?? 'all',
            (v) => updateConds({ logic: v, groups })
          ),
          'groups are AND-combos of their conditions'
        )
      ),
      ...groups.map((g, gi) => groupEditor(gi, g, groups, updateConds, s)),
      h(
        'div',
        { class: 'row row--tight' },
        btn('+ condition group (OR)', () => updateConds({ logic: s.entryLogic ?? 'any', groups: [...groups, { logic: 'all', conds: [{ left: { kind: 'price', field: 'close' }, op: '>', right: { kind: 'num', value: 0 } }] }] }), { cls: 'xs' })
      ),
      hr(),
      h('h3', { class: 'sec', text: 'EXIT & RISK' }),
      exitEditor(s, setField),
      hr(),
      h('h3', { class: 'sec', text: 'SIZING & FREQUENCY' }),
      h(
        'div',
        { class: 'grid2' },
        field(
          'sizing',
          select(s.sizing?.mode ?? 'riskBudget', SIZINGS, (v) => {
            setField({ sizing: { ...s.sizing, mode: v } });
          }),
          s.sizing?.mode === 'riskBudget' ? 'stop is required — the loss between entry and stop is the budget' : 'uses the bracket below for stops'
        ),
        field(
          s.sizing?.mode === 'fixedQty' ? 'quantity' : s.sizing?.mode === 'riskBudget' ? 'risk per trade' : 'notional share',
          numberInput(
            s.sizing?.mode === 'fixedQty' ? s.sizing?.value ?? 1 : (s.sizing?.value ?? 0.005) * 100,
            (v) => {
              const value = s.sizing?.mode === 'fixedQty' ? v : v / 100;
              setField({ sizing: { ...s.sizing, value } });
            },
            { step: s.sizing?.mode === 'fixedQty' ? 0.001 : 0.1, suffix: s.sizing?.mode === 'fixedQty' ? 'units' : '%' }
          )
        )
      ),
      h(
        'div',
        { class: 'grid2' },
        field(
          'cooldown bars',
          numberInput(s.cooldownBars ?? 3, (v) => setField({ cooldownBars: Math.max(0, Math.round(v) || 0) }), { step: 1, min: 0 }),
          'bars to wait after an exit before re-entering'
        ),
        field(
          'short entry (if both)',
          s.direction === 'both' ? textInput(ruleText(s.entryShort), () => toast('edit the JSON tab to redefine the short leg', 'info')) : h('span', { class: 'muted', text: 'n/a' }),
          s.direction === 'both' ? 'inverse of the long trigger is used by default' : 'switch direction to "both" to enable'
        )
      ),
      errors.length ? h('div', { class: 'errs' }, ...errors.map((e) => h('p', { class: 'errs__i', text: `✕ ${e}` }))) : h('p', { class: 'okline', text: '✓ rule valid — entry fires on: ' + ruleText(s.entry) }),
      h(
        'div',
        { class: 'builder__acts' },
        btn(draft.runState === 'running' ? 'computing…' : 'backtest', () => run(s), { tone: 'primary', disabled: !!errors.length || draft.runState === 'running' }),
        btn('backtest + robustness', () => run(s, { full: true }), { disabled: !!errors.length || draft.runState === 'running' }),
        btn('deploy (shadow)', () => deployStrategy(s, 'shadow', errors), { disabled: !!errors.length }),
        btn('deploy (armed)', () => deployStrategy(s, 'armed', errors), { tone: 'danger', disabled: !!errors.length }),
        btn('clear', () => {
          draft.current = blank(state.symbol, state.tf);
          syncFromDraft();
          render();
        })
      )
    );
  }

  function groupEditor(gi, g, groups, updateConds, s) {
    const setLogic = (logic) => {
      const next = groups.map((x, i) => (i === gi ? { ...x, logic } : x));
      updateConds({ logic: s.entryLogic ?? 'all', groups: next });
    };
    const setCond = (ci, patchObj) => {
      const next = groups.map((x, i) => (i === gi ? { ...x, conds: x.conds.map((c, j) => (j === ci ? { ...c, ...patchObj } : c)) } : x));
      updateConds({ logic: s.entryLogic ?? 'all', groups: next });
    };
    const addCond = () => {
      const next = groups.map((x, i) => (i === gi ? { ...x, conds: [...x.conds, { left: { kind: 'ind', name: 'rsi', args: [14] }, op: '<', right: { kind: 'num', value: 35 } }] } : x));
      updateConds({ logic: s.entryLogic ?? 'all', groups: next });
    };
    const rmCond = (ci) => {
      const next = groups
        .map((x, i) => (i === gi ? { ...x, conds: x.conds.filter((_, j) => j !== ci) } : x))
        .filter((x) => x.conds.length);
      updateConds({ logic: s.entryLogic ?? 'all', groups: next.length ? next : [{ logic: 'all', conds: [] }] });
    };
    const rmGroup = () => {
      const next = groups.filter((_, i) => i !== gi);
      updateConds({ logic: s.entryLogic ?? 'any', groups: next.length ? next : [{ logic: 'all', conds: [] }] });
    };
    return h(
      'div',
      { class: 'grp' },
      h(
        'div',
        { class: 'grp__head' },
        h('b', { text: `GROUP ${gi + 1}` }),
        segmented(
          [
            { id: 'all', label: 'AND' },
            { id: 'any', label: 'OR' },
          ],
          g.logic,
          setLogic,
          { size: 'xs' }
        ),
        h('span', { class: 'grp__spacer' }),
        btn('− group', rmGroup, { cls: 'xs' })
      ),
      ...g.conds.map((c, ci) => conditionRow(ci, c, g, setCond, rmCond)),
      btn('+ condition', addCond, { cls: 'xs ghost' })
    );
  }

  function conditionRow(ci, cond, group, setCond, rmCond) {
    return h(
      'div',
      { class: 'cond' },
      operandEditor(cond.left, (left) => setCond(ci, { left })),
      select(cond.op, CONDITION_OPS.map((o) => ({ value: o.id, label: o.label })), (v) => setCond(ci, { op: v }), { cls: 'cond__op' }),
      cond.op === 'between'
        ? h(
            'div',
            { class: 'cond__pair' },
            operandEditor(cond.right?.[0], (v) => setCond(ci, { right: [v, cond.right?.[1] ?? v] })),
            operandEditor(cond.right?.[1], (v) => setCond(ci, { right: [cond.right?.[0] ?? v, v] }))
          )
        : operandEditor(cond.right, (right) => setCond(ci, { right })),
      btn('×', () => rmCond(ci), { cls: 'xs danger ghost', title: 'remove condition' })
    );
  }

  function operandEditor(op, onPick) {
    const o = op ?? { kind: 'price', field: 'close' };
    const kind = o.kind ?? 'price';
    const setKind = (k) => {
      if (k === 'price') onPick({ kind: 'price', field: 'close' });
      else if (k === 'num') onPick({ kind: 'num', value: 0 });
      else if (k === 'ind') onPick({ kind: 'ind', name: 'rsi', args: [14] });
      else if (k === 'var') onPick({ kind: 'var', name: 'volumeRatio' });
      else onPick({ kind: 'lag', operand: { kind: 'ind', name: 'rsi', args: [14] }, n: 1 });
    };
    const kindSel = select(kind, [
      { value: 'price', label: 'price field' },
      { value: 'ind', label: 'indicator' },
      { value: 'num', label: 'number' },
      { value: 'var', label: 'context var' },
      { value: 'lag', label: 'N bars ago' },
    ], setKind, { cls: 'op__kind' });

    let detail = null;
    if (kind === 'price') {
      detail = select(o.field, PRICE_FIELDS.map((f) => ({ value: f, label: f })), (v) => onPick({ kind: 'price', field: v }), { cls: 'op__sel' });
    } else if (kind === 'num') {
      detail = numberInput(o.value ?? 0, (v) => onPick({ kind: 'num', value: Number.isFinite(v) ? v : 0 }), { step: 0.01, cls: 'op__num' });
    } else if (kind === 'var') {
      detail = select(o.name, VARS.map((v) => ({ value: v.id, label: v.label })), (v) => onPick({ kind: 'var', name: v }), { cls: 'op__sel' });
    } else if (kind === 'lag') {
      detail = h(
        'span',
        { class: 'op__lag' },
        numberInput(o.n ?? 1, (v) => onPick({ ...o, n: Math.max(1, Math.round(v) || 1) }), { step: 1, suffix: 'bars', cls: 'op__num' }),
        operandEditor(o.operand, (operand) => onPick({ kind: 'lag', n: o.n ?? 1, operand }))
      );
    } else {
      const names = Object.keys(INDICATOR_SPECS);
      const argCount = INDICATOR_SPECS[o.name]?.args?.length ?? 1;
      const parts = partsFor(o.name);
      detail = h(
        'span',
        { class: 'op__ind' },
        select(o.name, names.map((n) => ({ value: n, label: INDICATOR_SPECS[n].label })), (v) => onPick({ kind: 'ind', name: v, args: defaultArgs(v), part: partsFor(v) ? partsFor(v)[0].value : undefined }), { cls: 'op__sel' }),
        ...Array.from({ length: Math.min(3, Math.max(0, argCount)) }, (_, i) =>
          numberInput(o.args?.[i] ?? 14, (v) => {
            const args = [...(o.args ?? [])];
            args[i] = Math.max(1, Math.round(v) || 1);
            onPick({ ...o, args });
          }, { step: 1, cls: 'op__num op__num--sm' })
        ),
        parts ? select(o.part ?? parts[0].value, parts, (v) => onPick({ ...o, part: v }), { cls: 'op__sel op__sel--part' }) : null
      );
    }
    return h('div', { class: 'op' }, kindSel, detail);
  }

  function exitEditor(s, setField) {
    const e = s.exits ?? {};
    const hasExitRule = !!s.exit;
    const exitView = hasExitRule ? viewFromRule(s.exit, 'all', null) : null;
    const canEditExit = hasExitRule && exitView.length === 1;
    return h(
      'div',
      { class: 'exits' },
      h(
        'div',
        { class: 'grid2' },
        field(
          'stop loss',
          numberInput((e.stopPct ?? 0) * 100, (v) => setField({ exits: { ...e, stopPct: v / 100 } }), { step: 0.1, suffix: '%' }),
          'hard bracket, checked on every tick'
        ),
        field(
          'take profit',
          numberInput((e.takePct ?? 0) * 100, (v) => setField({ exits: { ...e, takePct: v / 100 } }), { step: 0.1, suffix: '%' }),
          '0 = run to the exit rule'
        )
      ),
      h(
        'div',
        { class: 'grid2' },
        field(
          'ATR trail',
          numberInput(e.trail?.mult ?? 0, (v) => setField({ exits: { ...e, trail: v > 0 ? { type: 'atr', period: 14, mult: v } : null } }), { step: 0.1, suffix: '×ATR' }),
          'ratcheting stop; 0 disables'
        ),
        field('time stop', numberInput(e.timeStopBars ?? 0, (v) => setField({ exits: { ...e, timeStopBars: Math.max(0, Math.round(v) || 0) } }), { step: 1, suffix: 'bars' }), '0 = hold indefinitely')
      ),
      hasExitRule
        ? canEditExit
          ? h('div', { class: 'exits__rule' }, h('h4', { class: 'sec', text: 'EXIT RULE' }), ...exitView[0].conds.map((c, ci) => conditionRow(ci, c, exitView[0], (patchObj) => {
              const conds = exitView[0].conds.map((x, j) => (j === ci ? { ...x, ...patchObj } : x));
              setField({ exit: ruleFromView('all', [{ logic: 'all', conds }]) });
            }, (idx) => {
              const conds = exitView[0].conds.filter((_, j) => j !== idx);
              setField({ exit: conds.length ? ruleFromView('all', [{ logic: 'all', conds }]) : null });
            })),
            btn('remove exit rule', () => setField({ exit: null }), { cls: 'xs' }))
          : h('p', { class: 'muted', text: `exit rule (nested — edit in JSON): ${ruleText(s.exit)}` })
        : h('p', { class: 'muted', text: 'no exit rule — positions close on stop/target/trail only' })
    );
  }

  /* ------------------------------------------------------------------ library */

  function library() {
    return h(
      'div',
      { class: 'lib' },
      h('p', { class: 'lib__note', text: 'Every preset states its failure mode. Read the note before the metrics — the note is the part that saves you money.' }),
      ...PRESETS.map((p) =>
        h(
          'div',
          { class: 'lib__row' },
          h(
            'div',
            { class: 'lib__main' },
            h('b', { text: p.name }),
            h('span', { class: 'lib__tags' }, ...p.tags.map((t) => badge(t, 'info'))),
            h('p', { text: p.blurb }),
            h('p', { class: 'lib__note lib__note--warn', text: `⚠ ${p.honestNote}` })
          ),
          h(
            'div',
            { class: 'lib__acts' },
            btn('load', () => {
              draft.current = fromPreset(p, { symbol: state.symbol, tf: state.tf });
              syncFromDraft();
              tab = 'builder';
              render();
            }, { cls: 'xs' }),
            btn('backtest', () => {
              draft.current = fromPreset(p, { symbol: p.symbol, tf: p.tf });
              syncFromDraft();
              run(draft.current, { full: true });
            }, { cls: 'xs', tone: 'primary' })
          )
        )
      )
    );
  }

  /* ------------------------------------------------------------------ json */

  function jsonEditor(errors) {
    const area = h('textarea', { class: 'jsonbox', spellcheck: 'false', rows: '22' });
    area.value = draft.json;
    return h(
      'div',
      { class: 'jsonwrap' },
      h('p', { class: 'muted', text: 'The strategy is plain JSON. Same schema the server would run, so a rule you author here is portable to production without translation.' }),
      area,
      h(
        'div',
        { class: 'row row--tight' },
        btn('apply', () => {
          try {
            const obj = JSON.parse(area.value);
            const errs = validateStrategy(obj);
            if (errs.length) return toast(`invalid: ${errs[0]}`, 'bad');
            draft.current = obj;
            syncFromDraft();
            tab = 'builder';
            render();
            toast('strategy applied');
          } catch (e) {
            toast(`JSON error: ${e.message}`, 'bad');
          }
        }, { tone: 'primary' }),
        btn('copy', async () => {
          try {
            await navigator.clipboard.writeText(draft.json);
            toast('strategy JSON copied');
          } catch {
            area.select();
            toast('select + copy manually (clipboard blocked)', 'warn');
          }
        }),
        errors.length ? badge(`${errors.length} errors`, 'down') : badge('valid', 'up')
      )
    );
  }

  /* ------------------------------------------------------------------ run */

  function run(s, { full = false, quick = false } = {}) {
    const errs = validateStrategy(s);
    if (errs.length) return toast(errs[0], 'bad');
    draft.runState = 'running';
    render();
    // one frame of breathing room so the "computing" state paints before a sync run
    setTimeout(() => {
      try {
        const ds = bars(s.symbol, s.tf);
        const maxBars = s.tf === '1m' ? 8000 : s.tf === '5m' ? 12000 : 100000;
        const from = Math.max(0, ds.len - maxBars);
        const window = { ...ds, minutes: minutesOf(s.tf) };
        const opts = { tfMinutes: minutesOf(s.tf), risk: { ...DEFAULT_RISK, ...account.risk }, startingEquity: 100000, range: { from } };
        const res = runBacktest(s, window, opts);
        const mc = monteCarlo(res.trades, { startingEquity: opts.startingEquity, runs: full ? 600 : 250 });
        const robust = full
          ? {
              wf: walkForward(s, window, { tfMinutes: minutesOf(s.tf), folds: 4, startingEquity: opts.startingEquity, risk: opts.risk }),
              sens: sensitivity(s, window, { tfMinutes: minutesOf(s.tf), startingEquity: opts.startingEquity, risk: opts.risk }),
            }
          : null;
        draft.result = { ...res, window, opts, mc, robust, strategyName: s.name, ranAt: Date.now(), quick };
        draft.runState = 'done';
        tab = 'results';
        state.lastResult = draft.result;
        log('ok', `backtest "${s.name}" on ${s.symbol} ${s.tf}: ${res.metrics.trades} trades, ${(res.metrics.totalReturn * 100).toFixed(2)}% net, PF ${res.metrics.profitFactor.toFixed(2)}, Sharpe ${res.metrics.sharpe.toFixed(2)}, MaxDD ${(res.metrics.maxDrawdown * 100).toFixed(1)}%`);
        render();
      } catch (err) {
        console.error(err);
        draft.runState = 'idle';
        toast(`backtest failed: ${err.message}`, 'bad');
        render();
      }
    }, 30);
  }

  function results(s) {
    const r = draft.result;
    if (!r) return empty('no research yet', 'run a backtest from the builder tab');
    const m = r.metrics;
    const bench = benchCurve(r.window, r.opts.range.from, m.startingEquity);
    const eqCanvas = h('canvas', { class: 'res__curve', width: 640, height: 168 });
    const verdict = verdictFor(m, r.mc, r.robust);
    setTimeout(() => drawEquity(eqCanvas, r.curve, bench), 0);
    return h(
      'div',
      { class: 'res' },
      h(
        'div',
        { class: 'res__head' },
        h('b', { text: `${r.strategyName} · ${s.symbol} ${s.tf}` }),
        h('span', { class: 'muted', text: `${fmtStamp(r.window.t[r.opts.range.from])} → ${fmtStamp(r.window.t[r.window.len - 1])} · ${r.window.len - r.opts.range.from} bars` })
      ),
      h('div', { class: `verdict verdict--${verdict.tone}` }, h('b', { text: verdict.head }), h('p', { text: verdict.body })),
      eqCanvas,
      h(
        'div',
        { class: 'stats stats--4' },
        stat('net return', fmtPct(m.totalReturn), `vs hold ${fmtPct(m.buyHold)}`, m.totalReturn >= 0 ? 'up' : 'down'),
        stat('sharpe', m.sharpe.toFixed(2), `sortino ${m.sortino.toFixed(2)}`, m.sharpe > 1 ? 'up' : m.sharpe > 0.5 ? 'warn' : 'down'),
        stat('max drawdown', fmtPct(m.maxDrawdown), `${m.maxDrawdownBars} bars peak-to-trough`, m.maxDrawdown > 0.25 ? 'down' : ''),
        stat('profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', `${m.winRate * 100 | 0}% of ${m.trades} trades`, m.profitFactor > 1.3 ? 'up' : 'down'),
        stat('expectancy', `${m.expectancyR >= 0 ? '+' : ''}${m.expectancyR.toFixed(3)}R`, `${m.trades} trades · ${(m.exposurePct * 100).toFixed(0)}% exposure`, m.expectancyR > 0.05 ? 'up' : 'down'),
        stat('avg win / loss', `${fmtMoney(m.avgWin, { compact: true })} / ${fmtMoney(m.avgLoss, { compact: true })}`, `${m.maxConsecutiveLosses} max losing streak`),
        stat('fees', fmtMoney(m.feesPaid), `${((m.feesPaid / Math.max(1, Math.abs(m.netPnl))) * 100).toFixed(0)}% of net P&L`),
        stat('avg hold', `${m.avgBars.toFixed(1)} bars`, `turnover ${m.turnover.toFixed(1)}×/yr`)
      ),
      r.mc
        ? h(
            'div',
            { class: 'robust' },
            h('h3', { class: 'sec', text: `MONTE CARLO · ${r.mc.runs} resamples of the trade sequence` }),
            h(
              'div',
              { class: 'stats stats--4' },
              stat('median return', fmtPct(r.mc.medianReturn)),
              stat('5th pct return', fmtPct(r.mc.p05Return), `95th ${fmtPct(r.mc.p95Return)}`, r.mc.p05Return < 0 ? 'down' : 'up'),
              stat('prob. losing money', fmtPct(r.mc.probLoss, 0), 'from the same trades, reshuffled'),
              stat('95th pct max DD', fmtPct(r.mc.ddP95), `median ${fmtPct(r.mc.ddMedian)}`, r.mc.ddP95 > 0.35 ? 'down' : '')
            ),
            h('p', { class: 'muted', text: 'Resampling preserves trade sizes and hit rate but destroys order. If the P95 drawdown is unacceptable, the strategy is fine — your sizing is not.' })
          )
        : null,
      r.robust?.wf?.ok
        ? h(
            'div',
            { class: 'robust' },
            h('h3', { class: 'sec', text: `WALK-FORWARD · ${r.robust.wf.folds.length} anchored folds (param: ${r.robust.wf.param})` }),
            h(
              'table',
              { class: 'tbl' },
              h('thead', {}, h('tr', {}, ...['fold', 'in-sample exp.', 'chosen', 'OOS return', 'OOS exp.', 'trades', 'OOS DD'].map((t) => h('th', { text: t })))),
              h(
                'tbody',
                {},
                ...r.robust.wf.folds.map((f) =>
                  h(
                    'tr',
                    {},
                    h('td', { text: String(f.fold) }),
                    h('td', { text: `${f.isExpectancy.toFixed(3)}R` }),
                    h('td', { text: String(f.chosenParam) }),
                    h('td', { class: f.oosReturn >= 0 ? 'up' : 'down', text: fmtPct(f.oosReturn) }),
                    h('td', { text: `${f.oosExpectancy.toFixed(3)}R` }),
                    h('td', { text: String(f.oosTrades) }),
                    h('td', { text: fmtPct(f.oosMaxDD) })
                  )
                )
              )
            ),
            h('div', { class: `verdict verdict--${r.robust.wf.verdict.tone}` }, h('b', { text: 'OVERFIT CHECK' }), h('p', { text: `${r.robust.wf.verdict.text} · OOS ${fmtPct(r.robust.wf.avgOosReturn)} vs IS ${fmtPct(r.robust.wf.avgIsReturn)}, expectancy degradation ${(r.robust.wf.degradation * 100).toFixed(0)}%` }))
          )
        : r.robust?.wf && !r.robust.wf.ok
          ? h('p', { class: 'muted', text: `walk-forward skipped: ${r.robust.wf.msg}` })
          : null,
      r.robust?.sens?.ok
        ? h(
            'div',
            { class: 'robust' },
            h('h3', { class: 'sec', text: `PARAMETER SENSITIVITY · ${r.robust.sens.param}(${r.robust.sens.baseParam})` }),
            h(
              'table',
              { class: 'tbl' },
              h('thead', {}, h('tr', {}, ...['param', 'return', 'sharpe', 'expectancy', 'trades'].map((t) => h('th', { text: t })))),
              h(
                'tbody',
                {},
                ...r.robust.sens.rows.map((x) =>
                  h(
                    'tr',
                    { class: x.param === r.robust.sens.baseParam ? 'is-base' : '' },
                    h('td', { text: String(x.param) }),
                    h('td', { class: x.returnPct >= 0 ? 'up' : 'down', text: fmtPct(x.returnPct) }),
                    h('td', { text: x.sharpe.toFixed(2) }),
                    h('td', { text: `${x.expectancyR.toFixed(3)}R` }),
                    h('td', { text: String(x.trades) })
                  )
                )
              )
            ),
            h('p', { class: 'muted', text: `dispersion ${Number.isFinite(r.robust.sens.dispersion) ? r.robust.sens.dispersion.toFixed(2) : '∞'} · ${pad2((r.robust.sens.positiveNeighbourhood * 100) | 0)}% of the neighbourhood is profitable. A narrow profitable ridge is a fitted artifact, not an edge.` })
          )
        : null,
      h('h3', { class: 'sec', text: `TRADE LOG · ${m.trades} closed${r.trades.filter((t) => t.open).length ? ' + 1 open' : ''}` }),
      h(
        'div',
        { class: 'res__trades' },
        h(
          'table',
          { class: 'tbl tbl--tight' },
          h('thead', {}, h('tr', {}, ...['#', 'side', 'entry', 'exit', 'bars', 'why', 'R', 'P&L'].map((t) => h('th', { text: t })))),
          h(
            'tbody',
            {},
            ...r.trades
              .slice(-80)
              .reverse()
              .map((t, i) =>
                h(
                  'tr',
                  {},
                  h('td', { text: String(r.trades.length - i) }),
                  h('td', { class: t.side === 'long' ? 'up' : 'down', text: t.side }),
                  h('td', { text: fmtPrice(t.entry, r.window.meta?.tick) }),
                  h('td', { text: fmtPrice(t.exit, r.window.meta?.tick) }),
                  h('td', { text: String(t.bars) }),
                  h('td', { class: 'muted', text: t.why ?? t.exitWhy }),
                  h('td', { class: (t.rMultiple ?? 0) >= 0 ? 'up' : 'down', text: `${(t.rMultiple ?? 0).toFixed(2)}` }),
                  h('td', { class: t.pnl >= 0 ? 'up' : 'down', text: (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) })
                )
              )
          )
        )
      ),
      h(
        'div',
        { class: 'row' },
        btn('deploy shadow from this result', () => deployStrategy(s, 'shadow', validateStrategy(s)), { tone: 'primary' }),
        btn('re-run', () => run(s, { full: !r.robust }), {})
      )
    );
  }

  function deployStrategy(s, mode, errors) {
    if (errors.length) return toast(errors[0], 'bad');
    if (mode === 'armed' && !draft.result) {
      toast('armed without a backtest — deploying into shadow instead. Run the numbers first.', 'warn', 6000);
      mode = 'shadow';
    }
    if (mode === 'armed' && draft.result) {
      const m = draft.result.metrics;
      const verdict = verdictFor(m, draft.result.mc, draft.result.robust);
      if (verdict.tone === 'bad') {
        log('reject', `"${s.name}" refused armed deploy — ${verdict.head}`);
        return toast(`refused: ${verdict.head}. Deploy in shadow mode instead.`, 'bad', 7000);
      }
    }
    const res = deploy({ ...s, mode }, {});
    if (!res.ok) return toast(res.errors[0], 'bad');
    toast(`"${s.name}" ${mode} on ${s.symbol} ${s.tf}`, mode === 'armed' ? 'warn' : 'ok');
    render();
  }

  return { render };
}

/* ------------------------------------------------------------------ helpers */

function minutesOf(tf) {
  return { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 }[tf] ?? 1;
}

function defaultArgs(name) {
  return [...(INDICATOR_SPECS[name]?.args ?? [14])];
}

function partsFor(name) {
  if (name === 'macd') return [{ value: 'line', label: 'line' }, { value: 'sig', label: 'signal' }, { value: 'hist', label: 'histogram' }];
  if (name === 'bb') return [{ value: 'up', label: 'upper' }, { value: 'mid', label: 'mid' }, { value: 'lo', label: 'lower' }, { value: 'w', label: 'width' }];
  if (name === 'donchian') return [{ value: 'hi', label: 'upper' }, { value: 'lo', label: 'lower' }];
  if (name === 'vwap') return [{ value: undefined, label: 'line' }, { value: 'up', label: '+2σ' }, { value: 'lo', label: '−2σ' }];
  if (name === 'stoch') return [{ value: undefined, label: '%K' }, { value: 'd', label: '%D' }];
  return null;
}

/** Flatten a rule tree into (logic, groups of conditions). */
export function viewFromRule(node, topLogic = 'all', cached = null) {
  if (cached) return cached;
  if (!node) return [{ logic: 'all', conds: [] }];
  // Flat same-op tree (the common case: N conditions joined by AND or OR) → one group.
  if (node.op === 'and' || node.op === 'or') {
    const kids = node.args ?? [];
    if (kids.length && kids.every(isLeaf)) {
      return [{ logic: node.op === 'or' ? 'any' : 'all', conds: kids }];
    }
  }
  const groups = [];
  const flatten = (n) => {
    if (!n) return;
    if (n.op === 'and' || n.op === 'or') {
      for (const c of n.args ?? []) {
        if (c.op === 'and' || c.op === 'or') groups.push({ logic: c.op === 'or' ? 'any' : 'all', conds: (c.args ?? []).filter(isLeaf) });
        else if (isLeaf(c)) groups.push({ logic: 'all', conds: [c] });
        else flatten(c);
      }
      return;
    }
    if (isLeaf(n)) groups.push({ logic: 'all', conds: [n] });
  };
  flatten(node);
  if (groups.length > 1 && groups.every((g) => g.logic === 'all')) {
    return [{ logic: topLogic === 'any' ? 'any' : 'all', conds: groups.flatMap((g) => g.conds) }];
  }
  return groups.length ? groups : [{ logic: 'all', conds: [] }];
}

function isLeaf(n) {
  return n && n.op !== 'and' && n.op !== 'or' && n.op !== 'not';
}

export function ruleFromView(logic, groups) {
  const leaves = (groups ?? [])
    .map((g) => {
      const conds = (g.conds ?? []).filter((c) => c?.op && (c.left || c.right));
      if (!conds.length) return null;
      const op = g.logic === 'any' ? 'or' : 'and';
      return conds.length === 1 ? conds[0] : { op, args: conds };
    })
    .filter(Boolean);
  if (!leaves.length) return { op: 'always' };
  if (leaves.length === 1) return leaves[0];
  return { op: logic === 'any' ? 'or' : 'and', args: leaves };
}

function benchCurve(window, from, startingEquity) {
  const out = new Float64Array(Math.max(0, window.len - from));
  const base = window.close[from] || 1;
  for (let i = from; i < window.len; i++) out[i - from] = startingEquity * (window.close[i] / base);
  return out;
}

function verdictFor(m, mc, robust) {
  const ddOk = m.maxDrawdown < 0.3;
  const expOk = m.expectancyR > 0.02;
  const tradesOk = m.trades >= 30;
  const oosOk = robust?.wf?.ok ? robust.wf.oosConsistency >= 0.5 : null;
  if (!tradesOk) {
    return {
      tone: 'warn',
      head: 'NOT SIGNIFICANT',
      body: `${m.trades} trades is too few to separate an edge from luck — widen the window or drop to a faster timeframe. Nothing here justifies capital yet.`,
    };
  }
  if (expOk && m.sharpe > 0.7 && ddOk && oosOk !== false) {
    return {
      tone: 'ok',
      head: 'TRADEABLE (SMALL)',
      body: `${m.trades} trades at ${m.expectancyR.toFixed(2)}R expectancy, PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}, Sharpe ${m.sharpe.toFixed(1)}, max DD ${(m.maxDrawdown * 100).toFixed(1)}%. Deploy in shadow first, then arm at quarter size.`,
    };
  }
  if (expOk && oosOk === false) {
    // the edge exists in-sample but the tuned parameter does not survive the split —
    // call it what it is instead of the misleading "no edge"
    return {
      tone: 'warn',
      head: 'IN-SAMPLE ONLY',
      body: `Expectancy ${m.expectancyR.toFixed(2)}R and PF ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'} look alive in-sample, but walk-forward keeps the edge in only ${(robust.wf.oosConsistency * 100).toFixed(0)}% of folds — a fitted parameter, not a law of the market. Shadow-only until the folds agree.`,
    };
  }
  if (expOk && !ddOk) {
    return {
      tone: 'warn',
      head: 'EDGE OK, RISK NOT',
      body: `Positive expectancy but a ${(m.maxDrawdown * 100).toFixed(0)}% drawdown. Cut the sizing — expectancy per R is unchanged, survival is not.${mc ? ` Monte Carlo P95 DD ${(mc.ddP95 * 100).toFixed(0)}%.` : ''}`,
    };
  }
  if (expOk) {
    return {
      tone: 'warn',
      head: 'THIN EDGE',
      body: `Positive expectancy (${m.expectancyR.toFixed(2)}R) but the quality flags disagree — Sharpe ${m.sharpe.toFixed(2)} or DD ${(m.maxDrawdown * 100).toFixed(1)}% is on the edge of tolerable. Fine for shadow, not for size.`,
    };
  }
  return {
    tone: 'bad',
    head: 'NO EDGE HERE',
    body: `Expectancy ${m.expectancyR.toFixed(2)}R, Sharpe ${m.sharpe.toFixed(2)}, ${m.trades} trades. Fees and slippage are already priced in — this is the honest number. Change the filter, not the sizing.`,
  };
}
