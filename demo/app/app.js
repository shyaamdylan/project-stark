// Ledra sandbox: a small accounts-payable app with fictional data, for
// recording Friday's demo. Bills list, a bill page with coding and approvals,
// hold / send for approval, undo. State lives in localStorage per data set;
// "Reset sandbox" puts it back for the next take.

(() => {
  const { COST_CENTERS, APPROVERS, SUPPLIERS, SETS, TODAY } = window.SANDBOX;
  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return n;
  };
  const svg = (d, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  };

  const money = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
  const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const STATUS = { review: 'To review', hold: 'On hold', approval: 'Awaiting approval', approved: 'Approved' };
  const USERS = { expert: { name: 'Sabine Keller', initials: 'SK' }, trainee: { name: 'Lena Maier', initials: 'LM' } };

  // ---------- state ----------

  const SET_KEY = 'ledra.sandbox.set';
  const read = (k, fallback) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  };
  let setName = read(SET_KEY, 'expert');
  if (!SETS[setName]) setName = 'expert';
  const billsKey = () => `ledra.sandbox.bills.${setName}`;
  const fresh = () =>
    SETS[setName].bills.map((b) => ({
      ...structuredClone(b),
      // As the OCR would: the suggested cost center is filled in, ready to check.
      costCenter: b.costCenter || b.suggested || '',
      activity: [{ at: b.date, text: b.received || 'Received by email · read by OCR' }],
    }));
  let bills = read(billsKey(), null) || fresh();
  const save = () => write(billsKey(), bills);

  const totals = (b) => {
    const net = b.lines.reduce((n, [, qty, price]) => n + qty * price, 0);
    const vat = Math.round(net * b.vatRate * 100) / 100;
    return { net, vat, gross: net + vat };
  };
  const centerName = (code) => (COST_CENTERS.find((c) => c.code === String(code).trim()) || {}).name || '';
  const supplierOf = (b) => SUPPLIERS[b.supplier];
  const initials = (name) => name.split(/[\s·]+/).filter((w) => /^[A-ZÄÖÜ]/.test(w)).slice(0, 2).map((w) => w[0]).join('');

  // ---------- toast with undo ----------

  let toastTimer = null;
  let undo = null;
  function toast(text, undoFn = null) {
    $('#toast-text').textContent = text;
    $('#toast-undo').hidden = !undoFn;
    undo = undoFn;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
  }
  $('#toast-undo').addEventListener('click', () => {
    if (undo) undo();
    undo = null;
    $('#toast').hidden = true;
  });

  // ---------- routing ----------

  const route = () => {
    const [, page, id] = location.hash.split('/');
    if (page === 'bills' && id) return { page: 'bill', id: decodeURIComponent(id) };
    const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'review';
    return { page: 'list', tab };
  };

  function render() {
    const r = route();
    const user = USERS[setName];
    $('#avatar').textContent = user.initials;
    $('#user-name').textContent = user.name;
    document.querySelectorAll('[data-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.set === setName)));
    $('#nav-count').textContent = String(bills.filter((b) => b.status === 'review').length || '');
    const view = $('#view');
    view.replaceChildren(r.page === 'bill' ? billPage(r.id) : listPage(r.tab));
    window.scrollTo(0, 0);
  }

  function crumbs(parts) {
    const nav = $('#crumbs');
    nav.replaceChildren();
    parts.forEach((p, i) => {
      if (i) nav.append(h('span', { class: 'sep', 'aria-hidden': 'true', text: '/' }));
      nav.append(p.href ? h('a', { href: p.href, text: p.text }) : h('span', { class: 'here', text: p.text }));
    });
  }

  // ---------- bills list ----------

  function listPage(tab) {
    crumbs([{ text: 'Payables', href: '#/bills' }, { text: 'Bills' }]);
    document.title = 'Bills · Ledra';
    const q = $('#search').value.trim().toLowerCase();
    const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, bills.filter((b) => b.status === k).length]));
    const open = bills.filter((b) => b.status !== 'approved');
    const openTotal = open.reduce((n, b) => n + totals(b).gross, 0);
    const daysToClose = Math.max(0, Math.round((new Date('2026-12-31') - new Date(TODAY)) / 86400000));

    const shown = bills
      .filter((b) => tab === 'all' || b.status === tab)
      .filter((b) => !q || `${b.id} ${supplierOf(b).name} ${b.costCenter}`.toLowerCase().includes(q))
      .sort((a, b) => a.date.localeCompare(b.date));

    const stat = (label, value) => h('div', { class: 'card stat' }, h('div', { class: 'stat-label', text: label }), h('div', { class: 'stat-value num', text: value }));
    const tabBtn = (key, label, n) =>
      h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(tab === key), onclick: () => (location.hash = `#/bills?tab=${key}`) }, label, n != null ? h('span', { class: 'tab-count', text: n }) : null);

    const rows = shown.map((b) => {
      const s = supplierOf(b);
      const t = totals(b);
      const tr = h(
        'tr',
        { onclick: () => (location.hash = `#/bills/${b.id}`) },
        h('td', {}, h('a', { class: 'row-link', href: `#/bills/${b.id}`, 'aria-label': `${b.id}, ${s.name}, ${money.format(t.gross)}` }), h('span', { class: 'bill-id', text: b.id })),
        h('td', {}, h('div', { class: 'supplier' }, h('span', { class: 'supplier-mark', 'aria-hidden': 'true', text: initials(s.name) }), h('div', {}, h('div', { class: 'supplier-name' }, s.name, s.country !== 'DE' ? h('span', { class: 'country', text: s.country }) : null), h('div', { class: 'supplier-meta', text: s.city })))),
        h('td', { class: 'num muted', text: day(b.date) }),
        h('td', { class: 'num muted', text: day(b.due) }),
        h('td', {}, b.costCenter ? h('span', { class: 'code', text: b.costCenter }) : h('span', { class: 'muted', text: '—' })),
        h('td', { class: 'right num', text: money.format(t.gross) }),
        h('td', {}, h('span', { class: `badge ${b.status}`, text: STATUS[b.status] }))
      );
      return tr;
    });

    return h(
      'div',
      { class: 'page' },
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { class: 'page-title', text: 'Bills' }), h('div', { class: 'page-sub', text: 'Supplier invoices to check, code and send for approval.' })), h('span', { class: 'close-pill' }, svg('M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z'), 'December close in ', h('b', { text: `${daysToClose} days` }))),
      h('div', { class: 'stats' }, stat('To review', String(counts.review)), stat('On hold', String(counts.hold)), stat('Awaiting approval', String(counts.approval)), stat('Open amount', money.format(openTotal))),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'tabs', role: 'tablist' }, tabBtn('review', 'To review', counts.review), tabBtn('hold', 'On hold', counts.hold), tabBtn('approval', 'Awaiting approval', counts.approval), tabBtn('approved', 'Approved', counts.approved), tabBtn('all', 'All', bills.length)),
        h(
          'table',
          { class: 'bills' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Bill' }), h('th', { text: 'Supplier' }), h('th', { text: 'Invoice date' }), h('th', { text: 'Due' }), h('th', { text: 'Cost center' }), h('th', { class: 'right', text: 'Amount' }), h('th', { text: 'Status' }))),
          h('tbody', {}, rows.length ? rows : h('tr', { class: 'empty-row' }, h('td', { colspan: '7', text: q ? 'No bills match your search.' : 'Nothing here. Nice work.' })))
        )
      )
    );
  }

  // ---------- one bill ----------

  function billPage(id) {
    const b = bills.find((x) => x.id === id);
    if (!b) {
      crumbs([{ text: 'Bills', href: '#/bills' }, { text: id }]);
      return h('div', { class: 'page' }, h('h1', { class: 'page-title', text: 'Bill not found' }), h('p', { class: 'muted' }, h('a', { href: '#/bills', text: 'Back to bills' })));
    }
    const s = supplierOf(b);
    const t = totals(b);
    crumbs([{ text: 'Bills', href: '#/bills' }, { text: b.id }]);
    document.title = `${b.id} · ${s.name} · Ledra`;
    const editable = b.status === 'review' || b.status === 'hold';

    // Coding
    const cc = h('input', { class: 'input code', id: 'cost-center', name: 'cost-center', value: b.costCenter, list: 'cost-centers', autocomplete: 'off', spellcheck: 'false', disabled: !editable });
    const ccName = h('div', { class: 'hint', id: 'cost-center-name', text: centerName(b.costCenter) || 'Enter a cost center code' });
    cc.addEventListener('input', () => {
      b.costCenter = cc.value.trim();
      ccName.textContent = centerName(b.costCenter) || (b.costCenter ? 'Unknown cost center' : 'Enter a cost center code');
      save();
    });
    const asset = h('input', { class: 'input code', id: 'asset-no', name: 'asset-no', value: b.assetNo, placeholder: 'AN-2026-000', autocomplete: 'off', spellcheck: 'false', disabled: !editable });
    asset.addEventListener('input', () => {
      b.assetNo = asset.value.trim();
      save();
    });
    const note = h('textarea', { class: 'input', id: 'note', name: 'note', disabled: !editable }, b.note);
    note.addEventListener('input', () => {
      b.note = note.value;
      save();
    });

    const approverList = h('div', { class: 'approvers' });
    const drawApprovers = () => {
      approverList.replaceChildren(
        ...b.approvers.map((a, i) =>
          h(
            'div',
            { class: 'approver' },
            h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(a) }),
            h('span', { class: 'approver-name', text: a }),
            h('span', { class: 'approver-step', text: `Step ${i + 1}` }),
            editable && i > 0 ? h('button', { class: 'remove', type: 'button', 'aria-label': `Remove ${a}`, text: 'Remove', onclick: () => { b.approvers.splice(i, 1); save(); drawApprovers(); drawAdd(); } }) : null
          )
        )
      );
    };
    const addWrap = h('div', { class: 'field' });
    const drawAdd = () => {
      addWrap.replaceChildren();
      const left = APPROVERS.filter((a) => !b.approvers.includes(a));
      if (!editable || !left.length) return;
      const sel = h('select', { class: 'input', id: 'add-approver', name: 'add-approver' }, h('option', { value: '', text: 'Choose a person…' }), ...left.map((a) => h('option', { value: a, text: a })));
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        b.approvers.push(sel.value);
        save();
        drawApprovers();
        drawAdd();
      });
      addWrap.append(h('label', { for: 'add-approver', text: 'Add approver' }), sel);
    };
    drawApprovers();
    drawAdd();

    const coding = h(
      'section',
      { class: 'card', 'aria-labelledby': 'coding-title' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'coding-title', text: 'Coding' }), h('span', { class: 'card-sub', text: 'Checked by you before approval' })),
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'fields' },
          h('div', { class: 'field' }, h('label', { for: 'cost-center', text: 'Cost center' }), cc, ccName, b.suggested ? h('span', { class: 'suggest' }, svg('M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M4.2 11.8l1.4-1.4M10.4 5.6l1.4-1.4'), 'Suggested by OCR: ', h('span', { class: 'code', text: b.suggested })) : null),
          h('div', { class: 'field' }, h('label', { for: 'asset-no', text: 'Asset number' }), asset, h('div', { class: 'hint', text: 'For fixed assets, from the asset register' })),
          h('div', { class: 'field wide' }, h('label', { for: 'note', text: 'Internal note' }), note)
        ),
        h('datalist', { id: 'cost-centers' }, ...COST_CENTERS.map((c) => h('option', { value: c.code, label: `${c.code} · ${c.name}` })))
      )
    );

    const approvals = h(
      'section',
      { class: 'card', 'aria-labelledby': 'approvals-title' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'approvals-title', text: 'Approvals' }), h('span', { class: 'card-sub', text: `${b.approvers.length} ${b.approvers.length === 1 ? 'approver' : 'approvers'}` })),
      h('div', { class: 'card-body stack', style: 'gap:14px' }, approverList, addWrap)
    );

    const lines = h(
      'section',
      { class: 'card', 'aria-labelledby': 'lines-title' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'lines-title', text: 'Line items' }), h('span', { class: 'card-sub', text: b.reverseCharge ? 'Reverse charge, no VAT' : `VAT ${Math.round(b.vatRate * 100)}%` })),
      h(
        'table',
        { class: 'lines' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Description' }), h('th', { class: 'right', text: 'Qty' }), h('th', { class: 'right', text: 'Unit price' }), h('th', { class: 'right', text: 'Amount' }))),
        h('tbody', {}, ...b.lines.map(([d, qty, price]) => h('tr', {}, h('td', { text: d }), h('td', { class: 'right num', text: qty }), h('td', { class: 'right num', text: money.format(price) }), h('td', { class: 'right num', text: money.format(qty * price) }))))
      ),
      h('div', { class: 'totals' }, h('span', { class: 'label', text: 'Net' }), h('span', { class: 'value', text: money.format(t.net) }), h('span', { class: 'label', text: b.reverseCharge ? 'VAT (reverse charge)' : `VAT ${Math.round(b.vatRate * 100)}%` }), h('span', { class: 'value', text: money.format(t.vat) }), h('span', { class: 'label grand', text: 'Total' }), h('span', { class: 'value grand', text: money.format(t.gross) }))
    );

    // The invoice as the supplier sent it.
    const doc = h(
      'section',
      { 'aria-label': 'Original invoice' },
      h('div', { class: 'doc-label' }, h('span', { text: 'Original invoice' }), h('span', { class: 'code', text: `${b.id.toLowerCase()}.pdf` })),
      h(
        'div',
        { class: 'doc' },
        h('div', { class: 'doc-top' }, h('div', {}, h('div', { class: 'doc-from', text: s.name }), h('div', { class: 'doc-addr', text: `${s.city}, ${s.country === 'DE' ? 'Germany' : 'Czech Republic'} · VAT ${s.vat}` })), h('div', { class: 'doc-word', text: 'Invoice' })),
        h('dl', { class: 'doc-facts' }, h('dt', { text: 'Bill to' }), h('dd', { text: 'Kestrel Maschinenbau GmbH, Stuttgart' }), h('dt', { text: 'Invoice no.' }), h('dd', { text: `${s.name.split(' ')[0].slice(0, 3).toUpperCase()}-${b.id.slice(-4)}-26` }), h('dt', { text: 'Date' }), h('dd', { text: day(b.date) }), h('dt', { text: 'Due' }), h('dd', { text: day(b.due) })),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Item' }), h('th', { class: 'right', text: 'Amount' }))), h('tbody', {}, ...b.lines.map(([d, qty, price]) => h('tr', {}, h('td', { text: qty > 1 ? `${d} × ${qty}` : d }), h('td', { class: 'right num', text: money.format(qty * price) }))))),
        h('div', { class: 'doc-total' }, h('span', { text: b.reverseCharge ? 'Total (reverse charge)' : 'Total incl. VAT' }), h('span', { text: money.format(t.gross) })),
        h('div', { class: 'doc-foot', text: `Payable to IBAN ${s.iban}` })
      )
    );

    const activity = h(
      'section',
      { class: 'card', 'aria-labelledby': 'activity-title' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'activity-title', text: 'Activity' })),
      h('ul', { class: 'activity' }, ...b.activity.slice().reverse().map((a) => h('li', {}, a.text, h('span', { class: 'when num', text: day(a.at) }))))
    );

    // Actions: hold, save, send for approval. Each can be undone from the toast.
    const act = (status, verb) => () => {
      const before = { status: b.status, activity: b.activity.slice() };
      b.status = status;
      b.activity.push({ at: TODAY, text: `${verb} by ${USERS[setName].name}` });
      save();
      location.hash = '#/bills';
      toast(`${b.id} ${status === 'hold' ? 'put on hold' : `sent to ${b.approvers[0].split(' · ')[0]}${b.approvers.length > 1 ? ` and ${b.approvers.length - 1} more` : ''}`}`, () => {
        Object.assign(b, before);
        save();
        render();
      });
    };
    const actions = editable
      ? h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: act('hold', 'Put on hold') }, svg('M6 4v8M10 4v8'), 'Hold'),
          h('button', { class: 'btn', type: 'button', onclick: () => { b.activity.push({ at: TODAY, text: `Saved by ${USERS[setName].name}` }); save(); toast(`${b.id} saved`); render(); } }, 'Save'),
          h('button', { class: 'btn primary', type: 'button', onclick: act('approval', 'Sent for approval') }, 'Send for approval')
        )
      : h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/bills' }, 'Back to bills'));

    return h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'bill-head' },
        h('div', {}, h('h1', { class: 'bill-title' }, s.name, h('span', { class: `badge ${b.status}`, text: STATUS[b.status] })), h('div', { class: 'bill-meta' }, h('span', {}, 'Bill ', h('b', { class: 'num', text: b.id })), h('span', {}, 'Invoice date ', h('b', { class: 'num', text: day(b.date) })), h('span', {}, 'Due ', h('b', { class: 'num', text: day(b.due) })), h('span', {}, 'Total ', h('b', { class: 'num', text: money.format(t.gross) })))),
        actions
      ),
      h('div', { class: 'bill-grid' }, h('div', { class: 'stack' }, coding, lines, approvals), h('div', { class: 'stack' }, doc, activity))
    );
  }

  // ---------- chrome: search, user menu, reset ----------

  $('#search').addEventListener('input', () => {
    if (route().page !== 'list') location.hash = '#/bills?tab=all';
    else render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('#search').focus();
    }
    if (e.key === 'Escape') closeMenu();
  });
  const menu = $('#user-menu');
  const closeMenu = () => {
    menu.hidden = true;
    $('#user').setAttribute('aria-expanded', 'false');
  };
  $('#user').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#user').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) closeMenu();
  });
  menu.querySelectorAll('[data-set]').forEach((b) =>
    b.addEventListener('click', () => {
      setName = b.dataset.set;
      write(SET_KEY, setName);
      bills = read(billsKey(), null) || fresh();
      closeMenu();
      location.hash = '#/bills';
      render();
    })
  );
  const reset = () => {
    bills = fresh();
    save();
    closeMenu();
    $('#search').value = '';
    location.hash = '#/bills';
    render();
    toast(`${SETS[setName].label} data reset`);
  };
  $('#reset').addEventListener('click', reset);
  $('#menu-reset').addEventListener('click', reset);

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/bills';
  render();
})();
