// Editor em tabela do Semáforo Env. Roda dentro do webview; nada aqui fala com a rede.
// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  /** @type {(key: string, value: string) => string} */
  // @ts-ignore
  const mask = window.maskValue;
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  let model = { name: '', keys: [], options: [], active: -1 };
  let showValues = false;
  let busy = false;

  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked') e.checked = !!v;
      else if (k === 'value') e.value = v;
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, String(v));
    }
    for (const c of children) if (c !== null && c !== undefined) e.append(c);
    return e;
  }

  function persist() {
    vscode.setState({ model, showValues });
  }

  function uniqueName(base) {
    const taken = new Set(model.options.map((o) => o.name.trim()));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(base + '-' + i)) return base + '-' + i;
  }

  function clearErrors() {
    $('errors').hidden = true;
    $('errors').replaceChildren();
  }

  function showErrors(list) {
    $('errors').replaceChildren(...list.map((t) => el('li', { text: t })));
    $('errors').hidden = list.length === 0;
  }

  function addNotice(text) {
    if (text) $('notices').append(el('p', { class: 'notice', text }));
  }

  function markActiveRow() {
    document.querySelectorAll('#grid tbody tr[data-row]').forEach((tr) => {
      tr.classList.toggle('active', Number(tr.getAttribute('data-row')) === model.active);
    });
  }

  function valueLabel(key, opt) {
    if (!has(opt.values, key)) return 'não definida';
    return showValues ? opt.values[key] || '(vazio)' : mask(key, opt.values[key]);
  }

  function cell(opt, key) {
    const defined = () => has(opt.values, key);
    const tip = () => (showValues && defined() ? opt.values[key] + '\n' : '') + 'Clique para editar';
    const view = el('button', { class: 'val mono' + (defined() ? '' : ' empty'), title: tip(), text: valueLabel(key, opt) });
    const input = el('input', {
      type: 'text',
      class: 'mono',
      value: defined() ? opt.values[key] : '',
      placeholder: 'não definida nesta opção',
      'aria-label': key + ' em ' + (opt.name || 'opção'),
      spellcheck: 'false',
    });
    input.hidden = true;
    let cancelled = false;
    view.addEventListener('click', () => {
      view.hidden = true;
      input.hidden = false;
      input.value = defined() ? opt.values[key] : '';
      cancelled = false;
      input.focus();
      input.select();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        cancelled = true;
        input.blur();
      }
    });
    input.addEventListener('blur', () => {
      if (!cancelled) {
        if (input.value.trim() === '') delete opt.values[key];
        else opt.values[key] = input.value;
        clearErrors();
        persist();
      }
      view.textContent = valueLabel(key, opt);
      view.title = tip();
      view.classList.toggle('empty', !defined());
      input.hidden = true;
      view.hidden = false;
    });
    return el('td', { class: 'c-val' }, view, input);
  }

  function render() {
    const grid = $('grid');
    const head = el(
      'tr',
      {},
      el('th', { class: 'c-active', title: 'A opção ativa é a única descomentada no .env', text: 'Ativa' }),
      el('th', { class: 'c-name', text: 'Opção' }),
      ...model.keys.map((k, ki) =>
        el(
          'th',
          { class: 'c-key' },
          el('span', { class: 'mono', text: k }),
          el('button', { class: 'icon', title: 'Tirar ' + k + ' do grupo', 'aria-label': 'Tirar ' + k + ' do grupo', text: '×', onclick: () => removeKey(ki) }),
        ),
      ),
      el('th', { class: 'c-danger', title: 'Banco ou serviço fora da sua máquina: pede confirmação e deixa o semáforo vermelho', text: 'Remoto' }),
      el('th', { class: 'c-del' }),
    );
    const body = el('tbody');
    if (model.keys.length === 0) {
      body.append(el('tr', { class: 'empty-row' }, el('td', { colspan: 4, text: 'Comece adicionando uma variável abaixo (ex.: DATABASE_URL). Os valores que já estão no .env entram sozinhos.' })));
    }
    model.options.forEach((opt, i) => {
      body.append(
        el(
          'tr',
          { 'data-row': i, class: (i === model.active ? 'active' : '') + (opt.danger ? ' danger' : '') },
          el(
            'td',
            { class: 'c-active' },
            el('input', {
              type: 'radio',
              name: 'active',
              checked: i === model.active,
              'aria-label': 'Deixar ' + (opt.name || 'esta opção') + ' ativa',
              onchange: () => {
                model.active = i;
                markActiveRow();
                clearErrors();
                persist();
              },
            }),
          ),
          el(
            'td',
            { class: 'c-name' },
            el('input', {
              type: 'text',
              value: opt.name,
              placeholder: 'nome',
              'aria-label': 'Nome da opção',
              spellcheck: 'false',
              oninput: (e) => {
                opt.name = e.target.value;
                persist();
              },
            }),
          ),
          ...model.keys.map((k) => cell(opt, k)),
          el(
            'td',
            { class: 'c-danger' },
            el('input', {
              type: 'checkbox',
              checked: opt.danger,
              'aria-label': (opt.name || 'Opção') + ' é remota',
              onchange: (e) => {
                opt.danger = e.target.checked;
                e.target.closest('tr').classList.toggle('danger', opt.danger);
                persist();
              },
            }),
          ),
          el('td', { class: 'c-del' }, el('button', { class: 'icon', title: 'Remover a opção', 'aria-label': 'Remover a opção ' + opt.name, text: '×', onclick: () => removeOption(i) })),
        ),
      );
    });
    grid.replaceChildren(el('thead', {}, head), body);
    // Em painéis estreitos, rola na horizontal em vez de espremer os valores.
    grid.style.minWidth = 310 + model.keys.length * 150 + 'px';
    persist();
  }

  function removeOption(i) {
    model.options.splice(i, 1);
    if (model.active === i) model.active = -1;
    else if (model.active > i) model.active--;
    render();
  }

  function removeKey(ki) {
    const [key] = model.keys.splice(ki, 1);
    addNotice(key + ' sai do grupo. Ao aplicar, ela fica no .env só com o valor da opção ativa (se a opção ativa não define, ela some do arquivo).');
    render();
  }

  function addOption() {
    model.options.push({ name: uniqueName('opcao'), danger: false, values: {}, origin: {} });
    if (model.active < 0) model.active = model.options.length - 1;
    render();
    const inputs = document.querySelectorAll('#grid tbody td.c-name input');
    const last = /** @type {HTMLInputElement | undefined} */ (inputs[inputs.length - 1]);
    if (last) {
      last.focus();
      last.select();
    }
  }

  function addKey() {
    const key = $('newKey').value.trim();
    const err = $('keyError');
    err.hidden = true;
    if (!key) {
      err.textContent = 'Digite o nome da variável, por exemplo DATABASE_URL.';
      err.hidden = false;
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      err.textContent = 'Use só letras, números e _ (sem começar com número).';
      err.hidden = false;
      return;
    }
    if (model.keys.includes(key)) {
      err.textContent = key + ' já é uma coluna.';
      err.hidden = false;
      return;
    }
    vscode.postMessage({ type: 'addKey', key, model });
  }

  $('name').addEventListener('input', (e) => {
    model.name = e.target.value;
    persist();
  });
  $('newKey').addEventListener('input', () => ($('keyError').hidden = true));
  $('newKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addKey();
  });
  $('addKey').addEventListener('click', addKey);
  $('addOption').addEventListener('click', addOption);
  $('show').addEventListener('change', (e) => {
    showValues = e.target.checked;
    render();
  });
  $('openFile').addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('apply').addEventListener('click', () => {
    if (busy) return;
    // Confirma o valor que estiver sendo digitado.
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    busy = true;
    $('keyError').hidden = true;
    $('apply').textContent = 'Aplicando…';
    clearErrors();
    vscode.postMessage({ type: 'apply', model });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
      const saved = vscode.getState();
      model = saved && saved.model ? saved.model : msg.model;
      showValues = !!(saved && saved.showValues);
      $('show').checked = showValues;
      $('name').value = model.name;
      $('file').textContent = msg.fileLabel ? 'em ' + msg.fileLabel : '';
      $('keyList').replaceChildren(...(msg.keySuggestions || []).map((k) => el('option', { value: k })));
      $('notices').replaceChildren();
      (msg.notices || []).forEach(addNotice);
      render();
      if (msg.isNew && !model.name) $('name').focus();
    } else if (msg.type === 'model') {
      model = msg.model;
      $('newKey').value = '';
      $('keyError').hidden = true;
      addNotice(msg.notice);
      render();
    } else if (msg.type === 'keyError') {
      $('keyError').textContent = msg.error;
      $('keyError').hidden = false;
    } else if (msg.type === 'errors') {
      busy = false;
      $('apply').textContent = 'Aplicar';
      showErrors(msg.errors || []);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
