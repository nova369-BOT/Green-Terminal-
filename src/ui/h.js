/**
 * Micro DOM layer. `h()` builds, `html` assigns, and each panel owns a `mount()`
 * that diffs only the nodes it cares about. At 2–6 updates/second a virtual DOM is
 * pure overhead; direct writes with a targeted diff is the honest choice here.
 */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = String(tag).split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export function mount(el, ...children) {
  clear(el);
  add(el, children);
  return el;
}

/** Class + attribute patching that avoids re-creating live nodes. */
export function patch(el, props = {}) {
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') {
      if (el.textContent !== String(v)) el.textContent = v;
    } else if (k === 'html') {
      if (el.innerHTML !== v) el.innerHTML = v;
    } else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v == null || v === false) el.removeAttribute(k);
    else if (v === true) el.setAttribute(k, '');
    else if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v));
  }
  return el;
}

export const toggle = (el, cls, on) => {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
  return el;
};

export function keypress(el, map) {
  el.addEventListener('keydown', (e) => {
    const fn = map[e.key];
    if (fn) {
      e.preventDefault();
      fn(e);
    }
  });
}

export function debounce(fn, ms = 120) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function segmented(items, active, onPick, { size = 'sm' } = {}) {
  return h(
    'div',
    { class: `seg seg--${size}`, role: 'tablist' },
    ...items.map((it) =>
      h(
        'button',
        {
          class: `seg__b ${it.id === active ? 'is-on' : ''}`,
          type: 'button',
          'aria-selected': it.id === active,
          title: it.title ?? it.label,
          onClick: () => onPick(it.id),
        },
        it.badge ? h('span', { class: 'seg__badge', text: String(it.badge) }) : null,
        it.label
      )
    )
  );
}

export function stat(label, value, sub = '', tone = '') {
  return h(
    'div',
    { class: `stat ${tone ? `stat--${tone}` : ''}` },
    h('span', { class: 'stat__k', text: label }),
    h('b', { class: 'stat__v', text: value }),
    sub ? h('span', { class: 'stat__s', text: sub }) : null
  );
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field__k', text: label }), input, hint ? h('em', { class: 'field__h', text: hint }) : null);
}

export function numberInput(value, onInput, { step = 1, min = null, max = null, suffix = '', cls = '' } = {}) {
  const input = h('input', {
    class: `input input--num ${cls}`,
    type: 'number',
    value: String(value ?? ''),
    step: String(step),
    inputmode: 'decimal',
    ...(min != null ? { min: String(min) } : {}),
    ...(max != null ? { max: String(max) } : {}),
    onInput: (e) => onInput(e.target.value === '' ? NaN : Number(e.target.value)),
  });
  if (!suffix) return input;
  return h('span', { class: 'inputwrap' }, input, h('i', { class: 'inputwrap__sfx', text: suffix }));
}

export function select(value, options, onChange, { cls = '' } = {}) {
  const sel = h('select', { class: `input input--select ${cls}`, onChange: (e) => onChange(e.target.value, e) }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value, text: o.label })));
  return sel;
}

export function textInput(value, onChange, { placeholder = '', cls = '' } = {}) {
  return h('input', { class: `input ${cls}`, type: 'text', value: value ?? '', placeholder, onInput: (e) => onChange(e.target.value) });
}

export function btn(label, onClick, { tone = '', cls = '', title = '', disabled = false, type = 'button' } = {}) {
  return h('button', { class: `btn btn--${tone || 'ghost'} ${cls}`, type, title, disabled, onClick }, label);
}

export const kv = (k, v, tone = '') => h('div', { class: `kv ${tone ? `kv--${tone}` : ''}` }, h('span', { text: k }), h('b', { text: v }));

export const row = (...children) => h('div', { class: 'row' }, ...children);
export const col = (...children) => h('div', { class: 'col' }, ...children);
export const gap = (px = 8) => h('div', { class: 'gap', style: { height: `${px}px` } });
export const hr = () => h('div', { class: 'rule' });
export const badge = (text, tone = 'muted') => h('span', { class: `badge badge--${tone}`, text });
export const empty = (text, hint = '') => h('div', { class: 'empty' }, h('p', { text }), hint ? h('small', { text: hint }) : null);
