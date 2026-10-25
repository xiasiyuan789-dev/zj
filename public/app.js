import { encrypt, decrypt, hashPassword } from './crypto.js';

const API_BASE = '/functions/v1/app';
let vaultData = null;
let currentPassword = null;
let vaultId = null;

// OCR state
let ocrMode = null;
let ocrWorker = null;
let ocrLoading = false;
let pendingProductType = '';

// Chart state
let chartRange = 'all';

// 金额显隐（隐私模式）：开启后所有金额/份额/净值以 **** 显示，状态持久化
let privacyMode = false;
try { privacyMode = localStorage.getItem('fv-privacy') === '1'; } catch {}

function maskText(s) { return privacyMode ? '****' : String(s); }

// 金额千位符格式化：1234567.8 -> 1,234,567.80
function thousands(n) {
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const PRODUCT_TYPES = ['股票型基金', '债券型基金', '现金', '理财', '股票', '期权'];

// --- Cash & holding side effects of transactions ---
const EPSILON = 0.000001;

function roundMoney(v) { return Math.round(v * 100) / 100; }

function getCashHoldings(accountId) {
  return (vaultData?.holdings || []).filter(h => h.accountId === accountId && h.productType === '现金');
}

function getAccountCash(accountId) {
  return getCashHoldings(accountId).reduce((sum, h) => sum + (h.shares || 0), 0);
}

function makeCashHolding(accountId, amount, date) {
  return { id: crypto.randomUUID(), accountId, productType: '现金', fundCode: '', fundName: '', shares: roundMoney(amount), costPerShare: 1, currentNav: 1, date };
}

// Apply a cash delta to an account; positive creates a cash holding if the account has none
function adjustAccountCash(accountId, delta) {
  const cashList = getCashHoldings(accountId);
  if (delta >= 0) {
    if (cashList.length === 0) {
      vaultData.holdings.push(makeCashHolding(accountId, delta, new Date().toISOString().split('T')[0]));
    } else {
      cashList[0].shares = roundMoney((cashList[0].shares || 0) + delta);
    }
    return;
  }
  let need = -delta;
  for (const h of cashList) {
    const take = Math.min(h.shares || 0, need);
    h.shares = roundMoney((h.shares || 0) - take);
    need -= take;
    if (need <= EPSILON) break;
  }
}

function getFundHolding(accountId, fundCode, fundName) {
  const list = (vaultData?.holdings || []).filter(h => h.accountId === accountId && h.productType !== '现金');
  if (fundCode) {
    const byCode = list.find(h => h.fundCode === fundCode);
    if (byCode) return byCode;
  }
  return list.find(h => h.fundName === fundName);
}

// Validate then apply buy/sell side effects on holdings and cash; returns an error message or null
function applyTransactionEffects({ accountId, fundCode, fundName, type, price, shares }) {
  const amount = price * shares;
  if (type === 'buy') {
    if (getAccountCash(accountId) + EPSILON < amount) return '现金不足';
    const holding = getFundHolding(accountId, fundCode, fundName);
    if (holding) {
      holding.shares = roundMoney((holding.shares || 0) + shares);
    } else {
      vaultData.holdings.push({ id: crypto.randomUUID(), accountId, productType: '', fundCode: fundCode || '', fundName, shares, costPerShare: price, currentNav: price, date: new Date().toISOString().split('T')[0] });
    }
    adjustAccountCash(accountId, -amount);
  } else if (type === 'sell') {
    const holding = getFundHolding(accountId, fundCode, fundName);
    if (!holding || (holding.shares || 0) + EPSILON < shares) return '份额不足';
    holding.shares = roundMoney((holding.shares || 0) - shares);
    adjustAccountCash(accountId, amount);
  }
  // dividend has no side effects on holdings or cash
  return null;
}

// Calculate shares and cost from transactions for a fund (used when adding new holding)
function calculateSharesAndCostFromTransactions(accountId, fundCode, fundName) {
  const transactions = (vaultData?.transactions || []).filter(t => {
    if (t.accountId !== accountId) return false;
    if (fundCode && t.fundCode) return t.fundCode === fundCode;
    return t.fundName === fundName;
  });

  if (transactions.length === 0) return { shares: NaN, costPerShare: NaN };

  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  let totalShares = 0;
  let totalCost = 0;

  for (const tx of sorted) {
    if (tx.type === 'buy') {
      totalShares += tx.shares;
      totalCost += tx.amount;
    } else if (tx.type === 'sell') {
      if (totalShares > 0) {
        const avgCost = totalCost / totalShares;
        totalShares -= tx.shares;
        totalCost = totalShares * avgCost;
      }
    }
  }

  if (totalShares <= 0) return { shares: 0, costPerShare: 0 };
  return { shares: totalShares, costPerShare: totalCost / totalShares };
}

// Populate fund dropdown in transaction modal with holding fund names
function populateTxFundSelect(accountId) {
  const select = document.getElementById('ocr-tx-fund');
  if (!select) return;

  select.innerHTML = '<option value="">选择持仓基金</option>';

  if (!accountId) return;

  // Get unique funds from holdings for this account (exclude cash)
  const holdings = (vaultData?.holdings || []).filter(h => h.accountId === accountId && h.productType !== '现金');
  // Deduplicate by fundName
  const seen = new Set();
  holdings.forEach(h => {
    if (!h.fundName || seen.has(h.fundName)) return;
    seen.add(h.fundName);
    const label = h.fundCode ? `${h.fundName} (${h.fundCode})` : h.fundName;
    const opt = document.createElement('option');
    opt.value = h.fundName;
    opt.textContent = label;
    opt.dataset.fundCode = h.fundCode || '';
    select.appendChild(opt);
  });
}

// Auto-calculate transaction amount from price * shares
function calcTxAmount(priceId, sharesId, amountId) {
  const price = parseFloat(document.getElementById(priceId).value);
  const shares = parseFloat(document.getElementById(sharesId).value);
  if (!isNaN(price) && !isNaN(shares)) {
    document.getElementById(amountId).value = (price * shares).toFixed(2);
  } else {
    document.getElementById(amountId).value = '';
  }
}

// --- API ---
const API_ERROR_COPY = {
  invalid_input: '提交的数据有误，请检查后重试',
  not_found: '未找到对应数据，请刷新后重试',
  method_not_allowed: '请求方式不受支持，请刷新页面后重试',
  database_request_failed: '服务器暂时不可用，请稍后重试',
  database_runtime_unavailable: '服务器暂时不可用，请稍后重试',
};

function friendlyError(code) {
  return API_ERROR_COPY[code] || '操作失败，请稍后重试';
}

async function api(action, body = null) {
  const opts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const url = body ? `${API_BASE}?action=${action}` : `${API_BASE}?action=${action}&id=${vaultId}`;
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('网络连接失败，请检查网络后重试');
  }
  if (!res.ok) {
    console.error('API request failed:', action, res.status);
    // 金库已在服务端被重建/清理时，旧页面的保存会 404，给出可操作的提示
    if (res.status === 404 && action === 'save') throw new Error('登录状态已失效，请刷新页面后重新登录');
    const code = res.status === 400 ? 'invalid_input' : res.status === 404 ? 'not_found' : res.status === 503 ? 'database_request_failed' : '';
    throw new Error(friendlyError(code));
  }
  return res.json();
}

// --- Auth ---
async function handleAuth(e) {
  e.preventDefault();
  const form = e.target;
  const isRegister = form.dataset.mode === 'register';
  const password = form.password.value;
  const confirm = form.confirm?.value;

  if (password.length < 6) return showError('密码至少6位');
  if (isRegister && password !== confirm) return showError('两次密码不一致');

  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = '处理中...';

  try {
    const pwHash = await hashPassword(password);
    if (isRegister) {
      const emptyVault = JSON.stringify({ accounts: [], holdings: [], transactions: [], snapshots: [], journal: [] });
      const encrypted = await encrypt(emptyVault, password);
      const result = await api('register', { passwordHash: pwHash, encryptedData: encrypted });
      if (result.error) {
        console.error('Register failed:', result.error);
        throw new Error(friendlyError(result.error));
      }
      vaultId = result.id;
      currentPassword = password;
      vaultData = JSON.parse(emptyVault);
    } else {
      const result = await api('login', { passwordHash: pwHash });
      if (result.error) {
        throw new Error(result.error === 'not_found' ? '未找到数据，请先注册' : friendlyError(result.error));
      }
      vaultId = result.id;
      try {
        const decrypted = await decrypt(result.encryptedData, password);
        vaultData = JSON.parse(decrypted);
        // Data migration: add snapshots array for old vaults
        if (!vaultData.snapshots) vaultData.snapshots = [];
        if (!vaultData.journal) vaultData.journal = [];
        currentPassword = password;
      } catch {
        throw new Error('密码错误');
      }
    }
    showDashboard();
  } catch (err) {
    showError(err && err.message ? err.message : '操作失败，请稍后重试');
  } finally {
    btn.disabled = false;
    btn.textContent = isRegister ? '注册' : '登录';
  }
}

// --- Snapshot ---
function buildSnapshot(dateStr, navOverrides) {
  const { accounts, holdings } = vaultData;
  let totalValue = 0, totalCost = 0;
  const items = holdings.map(h => {
    const shares = h.shares || 0;
    const nav = navOverrides && navOverrides.has(h.id) ? navOverrides.get(h.id) : (h.currentNav || 0);
    const value = shares * nav;
    const costPerShare = h.costPerShare || 0;
    const cost = shares * costPerShare;
    totalValue += value;
    totalCost += cost;
    const acc = accounts.find(a => a.id === h.accountId);
    return { accountId: h.accountId, accountName: acc?.name || '未知', productType: h.productType || '', fundName: h.fundName, shares: shares, costPerShare: costPerShare, currentNav: nav };
  });
  return { date: dateStr, totalValue, totalCost, holdings: items };
}

function upsertSnapshot(snapshot) {
  const idx = vaultData.snapshots.findIndex(s => s.date === snapshot.date);
  if (idx >= 0) vaultData.snapshots[idx] = snapshot;
  else vaultData.snapshots.push(snapshot);
}

function captureSnapshot(dateStr) {
  if (!vaultData || !vaultData.holdings || vaultData.holdings.length === 0) return;
  const date = dateStr || new Date().toISOString().split('T')[0];
  upsertSnapshot(buildSnapshot(date, null));
}

// --- Save ---
async function persistVault() {
  if (!vaultData || !currentPassword) return;
  const plaintext = JSON.stringify(vaultData);
  const encrypted = await encrypt(plaintext, currentPassword);
  const result = await api('save', { id: vaultId, encryptedData: encrypted });
  if (result.error) {
    console.error('Save failed:', result.error);
    throw new Error(friendlyError(result.error));
  }
}

async function saveVault() {
  if (!vaultData || !currentPassword) return;
  captureSnapshot();
  await persistVault();
}

// --- Render ---
function showError(msg) {
  const text = msg instanceof Error ? msg.message : String(msg ?? '');
  if (!text) return;
  const el = document.getElementById('error-msg');
  if (!el) { alert(text); return; }
  el.textContent = text;
  el.style.display = 'block';
  el.style.zIndex = '100000';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function showDashboard() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  renderDashboard();
}

// 已实现盈亏：按平均成本法回放全部买卖记录（分红/转账不参与）。
// 卖出时若交易历史里没有买入记录（如手动录入的持仓），退回用持仓上录的成本净值计算。
function computeRealizedPnl() {
  const holdingCost = new Map(); // accountId|代码或名称 -> 成本净值（兜底用）
  (vaultData?.holdings || []).forEach(h => {
    if (h.productType === '现金') return;
    if (h.fundCode) holdingCost.set(`${h.accountId}|${h.fundCode}`, h.costPerShare || 0);
    if (h.fundName) holdingCost.set(`${h.accountId}|${h.fundName}`, h.costPerShare || 0);
  });
  const groups = new Map(); // accountId|fund -> { shares, cost }
  (vaultData?.transactions || []).forEach(t => {
    if (t.type !== 'buy' && t.type !== 'sell') return;
    const key = `${t.accountId}|${t.fundCode || t.fundName || ''}`;
    if (!groups.has(key)) groups.set(key, { shares: 0, cost: 0 });
    const g = groups.get(key);
    if (t.type === 'buy') {
      g.shares += (t.shares || 0);
      g.cost += (t.amount != null ? t.amount : (t.price || 0) * (t.shares || 0));
    } else {
      let avg;
      if (g.shares > EPSILON) {
        avg = g.cost / g.shares;
      } else {
        const hc = holdingCost.get(key);
        if (hc == null) return; // 既无买入记录也无持仓成本，无法确定成本，不计入
        avg = hc;
      }
      const sold = g.shares > EPSILON ? Math.min(t.shares || 0, g.shares) : (t.shares || 0);
      g.realized = (g.realized || 0) + ((t.price || 0) - avg) * sold;
      if (g.shares > EPSILON) {
        g.shares -= sold;
        g.cost = g.shares * avg;
      }
    }
  });
  let realized = 0;
  groups.forEach(g => { realized += g.realized || 0; });
  return realized;
}

function renderDashboard() {
  const { accounts, holdings, transactions } = vaultData;
  document.getElementById('journal-date').value = new Date().toISOString().split('T')[0];
  let totalAssets = 0, totalCost = 0, cashTotal = 0, investTotal = 0;

  holdings.forEach(h => {
    const shares = h.shares || 0;
    const value = shares * (h.currentNav || 0);
    const cost = shares * (h.costPerShare || 0);
    totalAssets += value;
    totalCost += cost;
    if (h.productType === '现金') {
      cashTotal += value;
    } else {
      investTotal += value;
    }
  });

  // 总收益 = 浮动盈亏（当前持仓）+ 已实现盈亏（历史卖出落袋）
  const realized = computeRealizedPnl();
  const floatingPnl = totalAssets - totalCost;
  const totalPnl = floatingPnl + realized;
  // 收益率分母用原始投入（当前成本中含卖出盈利转存的现金，剔除已实现部分）
  const invested = totalCost - realized;
  const rateBase = invested > 0 ? invested : totalCost;
  const totalPnlRate = rateBase > 0 ? (totalPnl / rateBase * 100).toFixed(2) : '0.00';

  document.getElementById('total-assets').textContent = maskText(`¥${thousands(totalAssets)}`);
  document.getElementById('total-pnl').textContent = maskText(`${totalPnl >= 0 ? '+' : ''}¥${thousands(totalPnl)}`);
  document.getElementById('total-pnl').className = totalPnl >= 0 ? 'positive' : 'negative';
  document.getElementById('total-pnl-rate').textContent = maskText(`${totalPnl >= 0 ? '+' : ''}${totalPnlRate}%`);
  document.getElementById('total-pnl-rate').className = totalPnl >= 0 ? 'positive' : 'negative';
  const splitEl = document.getElementById('pnl-split');
  if (splitEl) {
    splitEl.textContent = maskText(`已实现 ${realized >= 0 ? '+' : ''}¥${thousands(realized)} · 浮动 ${floatingPnl >= 0 ? '+' : ''}¥${thousands(floatingPnl)}`);
    splitEl.className = 'stat-sub ' + (totalPnl >= 0 ? 'positive' : 'negative');
  }
  document.getElementById('account-count').textContent = accounts.length;
  document.getElementById('cash-total').textContent = maskText(`¥${thousands(cashTotal)}`);
  document.getElementById('invest-total').textContent = maskText(`¥${thousands(investTotal)}`);

  renderAccounts(accounts, holdings, transactions);
  renderHoldings(holdings, accounts);
  renderTransactions(transactions, accounts);
  renderTrendChart();
  renderAllocation();
  renderHistory();
  renderJournal();
}

function renderAccounts(accounts, holdings, transactions) {
  const container = document.getElementById('accounts-list');
  if (accounts.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无账户，请添加基金账户</div>';
    return;
  }
  container.innerHTML = accounts.map(acc => {
    const accHoldings = holdings.filter(h => h.accountId === acc.id);
    const accValue = accHoldings.reduce((sum, h) => sum + (h.shares || 0) * (h.currentNav || 0), 0);
    const accCost = accHoldings.reduce((sum, h) => sum + (h.shares || 0) * (h.costPerShare || 0), 0);
    const accPnl = accValue - accCost;
    return `
      <div class="account-card">
        <div class="account-header">
          <h3>${esc(acc.name)}</h3>
          <div class="account-actions">
            <button class="btn-icon" onclick="renameAccount('${acc.id}')" title="修改名称">✎</button>
            <button class="btn-icon" onclick="deleteAccount('${acc.id}')" title="删除账户">×</button>
          </div>
        </div>
        <div class="account-stats">
          <span>资产: ${maskText(`¥${thousands(accValue)}`)}</span>
          <span class="${accPnl >= 0 ? 'positive' : 'negative'}">收益: ${maskText(`${accPnl >= 0 ? '+' : ''}¥${thousands(accPnl)}`)}</span>
        </div>
      </div>`;
  }).join('');
}

// --- 持仓明细账户筛选 ---
let holdingFilter = ''; // '' = 全部账户
let holdingSort = '';   // '' = 默认顺序 | 'desc' | 'asc'（按总金额）

function renderHoldingFilter(accounts, holdings) {
  const el = document.getElementById('holding-filter');
  if (!el) return;
  const accsWithHoldings = accounts.filter(a => holdings.some(h => h.accountId === a.id));
  if (holdingFilter && !accsWithHoldings.some(a => a.id === holdingFilter)) holdingFilter = '';
  const chips = [{ id: '', name: '全部' }, ...accsWithHoldings.map(a => ({ id: a.id, name: a.name }))];
  el.innerHTML = chips.map(c =>
    `<button type="button" class="filter-chip ${holdingFilter === c.id ? 'active' : ''}" data-acc="${c.id}">${esc(c.name)}</button>`
  ).join('');
}

function renderHoldings(holdings, accounts) {
  renderHoldingFilter(accounts, holdings);
  const sortIcon = document.getElementById('th-sort-icon');
  if (sortIcon) {
    if (holdingSort === 'desc') { sortIcon.textContent = '▼'; sortIcon.classList.add('active'); }
    else if (holdingSort === 'asc') { sortIcon.textContent = '▲'; sortIcon.classList.add('active'); }
    else { sortIcon.textContent = '⇅'; sortIcon.classList.remove('active'); }
  }
  let visible = holdingFilter ? holdings.filter(h => h.accountId === holdingFilter) : [...holdings];
  if (holdingSort) {
    visible.sort((a, b) => {
      const va = (a.shares || 0) * (a.currentNav || 0);
      const vb = (b.shares || 0) * (b.currentNav || 0);
      return holdingSort === 'desc' ? vb - va : va - vb;
    });
  }
  if (visible.length === 0) {
    const tbody = document.getElementById('holdings-tbody');
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">暂无持仓数据</td></tr>';
    return;
  }
  const transactions = vaultData?.transactions || [];
  const tbody = document.getElementById('holdings-tbody');
  tbody.innerHTML = visible.map(h => {
    const acc = accounts.find(a => a.id === h.accountId);
    const isCash = h.productType === '现金';
    const marketValue = (h.shares || 0) * (h.currentNav || 0);

    const displayShares = h.shares || 0;
    const costPerShare = h.costPerShare || 0;

    const costValue = displayShares * costPerShare;
    const pnl = marketValue - costValue;
    const pnlRate = costValue > 0 ? (pnl / costValue * 100).toFixed(2) : '0.00';
    const name = isCash ? (h.fundName || '现金') : h.fundName;

    if (isCash) {
      // 现金是总金额而非份额：份额/成本净值/最新净值列显示 -，金额落在「总金额」列
      return `
        <tr>
          <td>${esc(acc?.name || '未知')}</td>
          <td><span class="product-type-tag cash-tag">${esc(h.productType)}</span></td>
          <td>${esc(name)}</td>
          <td>-</td>
          <td>-</td>
          <td>-</td>
          <td class="cash-amount-cell">${maskText(`¥${thousands(marketValue)}`)}</td>
          <td>-</td>
          <td>${h.date || '-'}</td>
          <td><button class="btn-edit" onclick="editHolding('${h.id}')">编辑</button></td>
        </tr>`;
    }
    const costLabel = maskText(costPerShare.toFixed(4));
    const sharesLabel = maskText(displayShares.toFixed(2));
    return `
      <tr>
        <td>${esc(acc?.name || '未知')}</td>
        <td><span class="product-type-tag">${esc(h.productType || '-')}</span></td>
        <td>${esc(h.fundName)}</td>
        <td>${sharesLabel}</td>
        <td>${costLabel}</td>
        <td>${maskText((h.currentNav || 0).toFixed(4))}</td>
        <td>${maskText(`¥${thousands(marketValue)}`)}</td>
        <td class="${pnl >= 0 ? 'positive' : 'negative'}">
          ${maskText(`${pnl >= 0 ? '+' : ''}¥${thousands(pnl)}`)} (${maskText(`${pnl >= 0 ? '+' : ''}${pnlRate}%`)})
        </td>
        <td>${h.date || '-'}</td>
        <td><button class="btn-edit" onclick="editHolding('${h.id}')">编辑</button></td>
      </tr>`;
  }).join('');
}

function renderTransactions(transactions, accounts) {
  const tbody = document.getElementById('transactions-tbody');
  if (transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">暂无交易记录</td></tr>';
    return;
  }
  const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
  tbody.innerHTML = sorted.map(t => {
    const acc = accounts.find(a => a.id === t.accountId);
    const isTransfer = t.type === 'transfer';
    const typeLabel = t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : isTransfer ? '转账' : '分红';
    const typeClass = t.type === 'buy' ? 'buy' : t.type === 'sell' ? 'sell' : isTransfer ? 'transfer' : 'dividend';
    const priceStr = t.price != null ? maskText(t.price.toFixed(4)) : '-';
    const sharesStr = t.shares != null ? maskText(t.shares.toFixed(2)) : '-';
    const toAcc = isTransfer ? accounts.find(a => a.id === t.toAccountId) : null;
    const accCell = isTransfer
      ? `${esc(acc?.name || '未知')} → ${esc(toAcc?.name || '未知')}`
      : esc(acc?.name || '未知');
    const editCell = isTransfer
      ? '<span class="tx-edit-disabled">-</span>'
      : `<button class="btn-edit" onclick="editTransaction('${t.id}')">编辑</button>`;
    return `
      <tr>
        <td>${esc(t.date)}</td>
        <td>${accCell}</td>
        <td>${esc(t.fundName)}</td>
        <td><span class="tx-type ${typeClass}">${typeLabel}</span></td>
        <td>${priceStr}</td>
        <td>${sharesStr}</td>
        <td>${t.type === 'dividend' ? '-' : maskText(`¥${thousands(t.amount)}`)}</td>
        <td>${editCell}</td>
      </tr>`;
  }).join('');
}

// --- Trend Chart ---
function renderTrendChart() {
  const snapshots = vaultData.snapshots || [];
  const section = document.getElementById('trend-section');

  if (snapshots.length < 1) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  let data = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  if (chartRange !== 'all') {
    const days = parseInt(chartRange);
    data = data.slice(-days);
  }

  const canvas = document.getElementById('trend-chart');
  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const displayW = container.clientWidth;
  const displayH = 280;
  canvas.width = displayW * dpr;
  canvas.height = displayH * dpr;
  canvas.style.width = displayW + 'px';
  canvas.style.height = displayH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, displayW, displayH);

  const pad = { top: 24, right: 20, bottom: 44, left: 64 };
  const w = displayW - pad.left - pad.right;
  const h = displayH - pad.top - pad.bottom;

  const values = data.map(s => s.totalValue);
  const costs = data.map(s => s.totalCost);
  const allVals = [...values, ...costs];
  let minV = Math.min(...allVals);
  let maxV = Math.max(...allVals);
  const range = maxV - minV || 1;
  minV -= range * 0.08;
  maxV += range * 0.08;

  // Grid
  ctx.strokeStyle = '#2a2d3a';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();

    const val = maxV - ((maxV - minV) / 4) * i;
    ctx.fillStyle = '#9ca3af';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(maskText(formatCompact(val)), pad.left - 8, y + 4);
  }

  // X labels
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  data.forEach((s, i) => {
    if (i % labelStep === 0 || i === data.length - 1) {
      const x = pad.left + (data.length > 1 ? (i / (data.length - 1)) * w : w / 2);
      ctx.fillText(s.date.slice(5), x, displayH - pad.bottom + 20);
    }
  });

  const toX = i => pad.left + (data.length > 1 ? (i / (data.length - 1)) * w : w / 2);
  const toY = v => pad.top + ((maxV - v) / (maxV - minV)) * h;

  // Cost area (subtle)
  if (data.length > 1) {
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(costs[0]));
    data.forEach((s, i) => ctx.lineTo(toX(i), toY(costs[i])));
    ctx.lineTo(toX(data.length - 1), pad.top + h);
    ctx.lineTo(toX(0), pad.top + h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(99,102,241,0.06)';
    ctx.fill();
  }

  // Value area gradient
  if (data.length > 1) {
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]));
    data.forEach((s, i) => ctx.lineTo(toX(i), toY(values[i])));
    ctx.lineTo(toX(data.length - 1), pad.top + h);
    ctx.lineTo(toX(0), pad.top + h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
    grad.addColorStop(0, 'rgba(34,197,94,0.25)');
    grad.addColorStop(1, 'rgba(34,197,94,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Cost line
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(99,102,241,0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  data.forEach((s, i) => { const x = toX(i), y = toY(costs[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);

  // Value line
  ctx.beginPath();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2.5;
  data.forEach((s, i) => { const x = toX(i), y = toY(values[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();

  // Data points
  data.forEach((s, i) => {
    const x = toX(i), y = toY(values[i]);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    ctx.strokeStyle = '#0f1117';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // Legend
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(pad.left, displayH - 14, 12, 3);
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('市值', pad.left + 16, displayH - 10);

  ctx.strokeStyle = 'rgba(99,102,241,0.4)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left + 56, displayH - 12);
  ctx.lineTo(pad.left + 68, displayH - 12);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText('成本', pad.left + 72, displayH - 10);

  // Hover
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const tooltip = document.getElementById('chart-tooltip');

    let closest = -1, minDist = Infinity;
    data.forEach((s, i) => {
      const x = toX(i), y = toY(values[i]);
      const d = Math.sqrt((mx - x) ** 2 + (my - y) ** 2);
      if (d < minDist) { minDist = d; closest = i; }
    });

    if (closest >= 0 && minDist < 40) {
      const s = data[closest];
      const pnl = s.totalValue - s.totalCost;
      const pnlRate = s.totalCost > 0 ? (pnl / s.totalCost * 100).toFixed(2) : '0.00';
      tooltip.innerHTML = `<div>${s.date}</div><div>市值: ${maskText(`¥${thousands(s.totalValue)}`)}</div><div>成本: ${maskText(`¥${thousands(s.totalCost)}`)}</div><div class="${pnl >= 0 ? 'positive' : 'negative'}">收益: ${maskText(`${pnl >= 0 ? '+' : ''}¥${thousands(pnl)} (${pnl >= 0 ? '+' : ''}${pnlRate}%)`)}</div>`;
      tooltip.style.display = 'block';
      const tx = toX(closest);
      const ty = toY(values[closest]);
      tooltip.style.left = Math.min(tx + 12, displayW - 180) + 'px';
      tooltip.style.top = Math.max(ty - 60, 4) + 'px';
    } else {
      tooltip.style.display = 'none';
    }
  };
  canvas.onmouseleave = () => { document.getElementById('chart-tooltip').style.display = 'none'; };
}

function formatCompact(n) {
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toFixed(0);
}

// --- 资产配置（产品类型占比环形图）---
const ALLOCATION_COLORS = {
  '股票型基金': '#6366f1',
  '债券型基金': '#38bdf8',
  '现金': '#22c55e',
  '理财': '#eab308',
  '股票': '#f97316',
  '期权': '#ec4899',
};

let allocationDate = 'latest'; // 'latest' = 当前持仓，否则为快照日期

function allocationColor(type) { return ALLOCATION_COLORS[type] || '#9ca3af'; }

// 计算某一时点各产品类型的市值：latest 用当前持仓，否则用当天快照
function computeAllocation(dateKey) {
  let items;
  if (!dateKey || dateKey === 'latest') {
    items = (vaultData?.holdings || []).map(h => ({ productType: h.productType || '其他', value: (h.shares || 0) * (h.currentNav || 0) }));
  } else {
    const snap = (vaultData?.snapshots || []).find(s => s.date === dateKey);
    if (!snap) return [];
    items = (snap.holdings || []).map(h => ({ productType: h.productType || '其他', value: (h.shares || 0) * (h.currentNav || 0) }));
  }
  const map = new Map();
  items.forEach(it => map.set(it.productType, (map.get(it.productType) || 0) + it.value));
  return [...map.entries()]
    .filter(([, v]) => v > 0)
    .map(([productType, value]) => ({ productType, value }))
    .sort((a, b) => b.value - a.value);
}

function renderAllocation() {
  const section = document.getElementById('allocation-section');
  if (!section) return;

  // 日期下拉：最新持仓 + 全部快照日期（倒序）
  const dates = [...new Set((vaultData?.snapshots || []).map(s => s.date))].sort().reverse();
  const options = ['latest', ...dates];
  if (!options.includes(allocationDate)) allocationDate = 'latest';
  const sel = document.getElementById('allocation-date');
  sel.innerHTML = options.map(d => `<option value="${d}">${d === 'latest' ? '最新持仓' : d}</option>`).join('');
  sel.value = allocationDate;

  const data = computeAllocation(allocationDate);
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  document.getElementById('allocation-legend').innerHTML = data.map(d => {
    const pct = (d.value / total) * 100;
    return `
      <div class="allocation-legend-row">
        <span class="allocation-dot" style="background:${allocationColor(d.productType)}"></span>
        <span class="allocation-name">${esc(d.productType)}</span>
        <span class="allocation-value">${maskText(`¥${thousands(d.value)}`)}</span>
        <span class="allocation-pct">${pct.toFixed(1)}%</span>
      </div>`;
  }).join('');

  // 环形图
  const canvas = document.getElementById('allocation-chart');
  const dpr = window.devicePixelRatio || 1;
  const size = 200;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2;
  const outer = size / 2 - 6;
  const inner = outer * 0.62;
  let start = -Math.PI / 2;
  data.forEach(d => {
    const angle = (d.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, start, start + angle);
    ctx.arc(cx, cy, inner, start + angle, start, true);
    ctx.closePath();
    ctx.fillStyle = allocationColor(d.productType);
    ctx.fill();
    ctx.strokeStyle = '#1a1d27';
    ctx.lineWidth = 2;
    ctx.stroke();
    start += angle;
  });

  const totalLabel = total >= 10000 ? `¥${(total / 10000).toFixed(2)}万` : `¥${thousands(total)}`;
  ctx.fillStyle = '#e4e4e7';
  ctx.font = '600 14px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(maskText(totalLabel), cx, cy + 5);
}

// Chart range buttons
document.querySelectorAll('.chart-range').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-range').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartRange = btn.dataset.range;
    renderTrendChart();
  });
});

// --- History ---
function renderHistory() {
  const snapshots = vaultData.snapshots || [];
  const section = document.getElementById('history-section');
  const container = document.getElementById('history-list');

  if (snapshots.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  const sorted = [...snapshots].sort((a, b) => b.date.localeCompare(a.date));
  container.innerHTML = sorted.map((snap, idx) => {
    const pnl = snap.totalValue - snap.totalCost;
    const pnlRate = snap.totalCost > 0 ? (pnl / snap.totalCost * 100).toFixed(2) : '0.00';
    const holdingsHtml = (snap.holdings || []).map(h => `
      <div class="history-holding-row">
        <span class="history-holding-name">${esc(h.accountName)} · ${esc(h.fundName)}</span>
        <span class="history-holding-detail">
          ${maskText(h.shares.toFixed(2))}份 · 净值${maskText(h.currentNav.toFixed(4))} ·
          <span class="${(h.shares * h.currentNav - h.shares * h.costPerShare) >= 0 ? 'positive' : 'negative'}">
            ${maskText(`${(h.shares * h.currentNav - h.shares * h.costPerShare) >= 0 ? '+' : ''}¥${thousands(h.shares * h.currentNav - h.shares * h.costPerShare)}`)}
          </span>
        </span>
      </div>
    `).join('');

    return `
      <div class="history-card">
        <div class="history-header" onclick="toggleHistory(${idx})">
          <div>
            <span class="history-date">${snap.date}</span>
            <span class="history-value">${maskText(`¥${thousands(snap.totalValue)}`)}</span>
          </div>
          <div class="history-summary">
            <span class="${pnl >= 0 ? 'positive' : 'negative'}">${maskText(`${pnl >= 0 ? '+' : ''}¥${thousands(pnl)} (${pnl >= 0 ? '+' : ''}${pnlRate}%)`)}</span>
            <span class="history-toggle" id="history-toggle-${idx}">▼</span>
          </div>
        </div>
        <div class="history-detail" id="history-detail-${idx}" style="display:none">
          ${holdingsHtml || '<div class="empty-state" style="padding:12px">无持仓数据</div>'}
        </div>
      </div>`;
  }).join('');
}

window.toggleHistory = function(idx) {
  const detail = document.getElementById(`history-detail-${idx}`);
  const toggle = document.getElementById(`history-toggle-${idx}`);
  if (detail.style.display === 'none') {
    detail.style.display = 'block';
    toggle.textContent = '▲';
  } else {
    detail.style.display = 'none';
    toggle.textContent = '▼';
  }
};

// --- Edit Holding ---
window.editHolding = function(id) {
  const h = vaultData.holdings.find(x => x.id === id);
  if (!h) return;

  populateAccountSelect('edit-holding-account');
  populateProductTypeSelect('edit-holding-product-type', h.productType || '');

  const isCash = h.productType === '现金';
  document.getElementById('edit-holding-id').value = h.id;
  document.getElementById('edit-holding-account').value = h.accountId;
  document.getElementById('edit-holding-date').value = h.date || new Date().toISOString().split('T')[0];

  if (isCash) {
    document.getElementById('edit-cash-group').style.display = 'block';
    document.getElementById('edit-investment-fields').style.display = 'none';
    document.getElementById('edit-holding-cash-amount').value = h.shares; // shares stores the cash amount
  } else {
    document.getElementById('edit-cash-group').style.display = 'none';
    document.getElementById('edit-investment-fields').style.display = 'block';
    document.getElementById('edit-holding-code').value = h.fundCode || '';
    document.getElementById('edit-holding-name').value = h.fundName;
    document.getElementById('edit-holding-shares').value = h.shares;
    document.getElementById('edit-holding-cost').value = h.costPerShare;
    document.getElementById('edit-holding-nav').value = h.currentNav;
  }

  document.getElementById('modal-edit-holding').style.display = 'flex';
};

function handleEditHolding(e) {
  e.preventDefault();
  const id = document.getElementById('edit-holding-id').value;
  const h = vaultData.holdings.find(x => x.id === id);
  if (!h) return showError('持仓不存在');

  const accountId = document.getElementById('edit-holding-account').value;
  const productType = document.getElementById('edit-holding-product-type').value;
  const date = document.getElementById('edit-holding-date').value;

  if (!accountId) return showError('请选择账户');
  if (!productType) return showError('请选择产品类型');
  if (!date) return showError('请选择日期');

  if (productType === '现金') {
    const cashAmount = parseFloat(document.getElementById('edit-holding-cash-amount').value);
    if (isNaN(cashAmount) || cashAmount < 0) return showError('请填写现金金额');
    h.accountId = accountId;
    h.productType = productType;
    h.fundCode = '';
    h.fundName = '';
    h.shares = cashAmount;
    h.costPerShare = 1;
    h.currentNav = 1;
    h.date = date;
  } else {
    const fundCode = document.getElementById('edit-holding-code').value.trim();
    const fundName = document.getElementById('edit-holding-name').value.trim();
    let shares = parseFloat(document.getElementById('edit-holding-shares').value);
    let costPerShare = parseFloat(document.getElementById('edit-holding-cost').value);
    let currentNav = parseFloat(document.getElementById('edit-holding-nav').value);
    if (!fundName) return showError('请填写基金名称');

    // If shares or cost not provided, try to calculate from transactions
    if (isNaN(shares) || isNaN(costPerShare)) {
      const txCalc = calculateSharesAndCostFromTransactions(accountId, fundCode, fundName);
      if (isNaN(shares)) shares = txCalc.shares;
      if (isNaN(costPerShare)) costPerShare = txCalc.costPerShare;
    }

    // Default to 0 if still not available
    if (isNaN(shares)) shares = 0;
    if (isNaN(costPerShare)) costPerShare = 0;
    if (isNaN(currentNav)) currentNav = costPerShare || 0;

    h.accountId = accountId;
    h.productType = productType;
    h.fundCode = fundCode;
    h.fundName = fundName;
    h.shares = shares;
    h.costPerShare = costPerShare;
    h.currentNav = currentNav;
    h.date = date;
  }

  saveVault()
    .then(() => { closeModal('modal-edit-holding'); renderDashboard(); })
    .catch(showError);
}

function esc(str) {
  if (str === undefined || str === null) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// --- Modal helpers ---
function populateAccountSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">选择账户</option>' +
    vaultData.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  if (current) sel.value = current;
}

function populateProductTypeSelect(selectId, currentValue) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">选择产品类型</option>' +
    PRODUCT_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  if (currentValue) sel.value = currentValue;
}

function openModal(id) {
  if (id === 'modal-holding' || id === 'modal-csv') {
    const selectMap = { 'modal-holding': 'hold-account', 'modal-csv': 'csv-account' };
    populateAccountSelect(selectMap[id]);
  }
  if (id === 'modal-holding') {
    document.getElementById('holding-upload-area').style.display = 'none';
    clearImagePreview('holding');
    document.getElementById('hold-product-type').value = '';
  }
  if (id === 'modal-transaction') {
    const today = new Date().toISOString().split('T')[0];
    txSelection = null;
    renderTxFundPicker();
    document.getElementById('tx-cash-bar').style.display = 'none';
    document.getElementById('tx-normal-fields').style.display = 'none';
    document.getElementById('tx-transfer-fields').style.display = 'none';
    document.getElementById('tx-upload-area').style.display = 'none';
    clearImagePreview('tx');
    document.getElementById('tx-type').value = 'buy';
    document.getElementById('tx-price').value = '';
    document.getElementById('tx-shares').value = '';
    document.getElementById('tx-amount').value = '';
    document.getElementById('tx-date').value = today;
    document.getElementById('tx-transfer-amount').value = '';
    document.getElementById('tx-to-account').value = '';
    populateToFundSelect('');
    document.getElementById('tx-transfer-date').value = today;
  }
  document.getElementById(id).style.display = 'flex';
}
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function checkHoldingUploadVisibility() {
  const acc = document.getElementById('hold-account').value;
  const pt = document.getElementById('hold-product-type').value;
  document.getElementById('holding-upload-area').style.display = (acc && pt) ? 'block' : 'none';
  if (acc && pt) pendingProductType = pt;
}

// --- Transaction modal: tiled account/fund picker ---
let txSelection = null; // { accountId, holdingId, isCash, fundCode, fundName }

function renderTxFundPicker() {
  const container = document.getElementById('tx-fund-picker');
  const accounts = vaultData?.accounts || [];
  const holdings = vaultData?.holdings || [];
  if (accounts.length === 0) {
    container.innerHTML = '<div class="picker-empty">暂无账户，请先添加基金账户和持仓</div>';
    return;
  }
  container.innerHTML = accounts.map(acc => {
    const accHoldings = holdings.filter(h => h.accountId === acc.id);
    const cashList = accHoldings.filter(h => h.productType === '现金');
    const funds = accHoldings.filter(h => h.productType !== '现金' && h.fundName);
    const tiles = [
      ...cashList.map(h => pickerTileHtml(h, '现金', `¥${thousands(h.shares || 0)}`, '💰')),
      ...funds.map(h => pickerTileHtml(h, h.fundCode ? `${h.fundName} (${h.fundCode})` : h.fundName, `${(h.shares || 0).toFixed(2)}份`, '📈'))
    ].join('');
    return `
      <div class="picker-account">
        <div class="picker-account-header">
          <span class="picker-account-name">${esc(acc.name)}</span>
          <span class="picker-account-cash">现金 ${maskText(`¥${thousands(getAccountCash(acc.id))}`)}</span>
        </div>
        <div class="picker-funds">${tiles || '<span class="picker-no-fund">无持仓</span>'}</div>
      </div>`;
  }).join('');
}

function pickerTileHtml(h, label, sub, icon) {
  const selected = txSelection && txSelection.holdingId === h.id;
  return `<button type="button" class="picker-tile${selected ? ' selected' : ''}" data-holding="${h.id}" onclick="selectTxFund('${h.id}')">
    <span class="picker-tile-icon">${icon}</span>
    <span class="picker-tile-body">
      <span class="picker-tile-name">${esc(label)}</span>
      <span class="picker-tile-sub">${maskText(sub)}</span>
    </span>
  </button>`;
}

window.selectTxFund = function(holdingId) {
  const h = (vaultData?.holdings || []).find(x => x.id === holdingId);
  if (!h) return;
  txSelection = {
    accountId: h.accountId,
    holdingId: h.id,
    isCash: h.productType === '现金',
    fundCode: h.fundCode || '',
    fundName: h.fundName || ''
  };
  document.querySelectorAll('#tx-fund-picker .picker-tile').forEach(b =>
    b.classList.toggle('selected', b.dataset.holding === holdingId));
  document.getElementById('tx-cash-bar').style.display = 'flex';
  document.getElementById('tx-cash-balance').textContent = maskText(`¥${thousands(getAccountCash(h.accountId))}`);
  const isCash = txSelection.isCash;
  document.getElementById('tx-normal-fields').style.display = isCash ? 'none' : 'block';
  document.getElementById('tx-transfer-fields').style.display = isCash ? 'block' : 'none';
  document.getElementById('tx-upload-area').style.display = isCash ? 'none' : 'block';
  if (isCash) populateToAccountSelect();
};

function populateToAccountSelect() {
  const sel = document.getElementById('tx-to-account');
  const accounts = vaultData?.accounts || [];
  sel.innerHTML = '<option value="">选择转入账户</option>' +
    accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  populateToFundSelect('');
}

function populateToFundSelect(toAccountId) {
  const sel = document.getElementById('tx-to-fund');
  if (!toAccountId) {
    sel.innerHTML = '<option value="">先选择转入账户</option>';
    return;
  }
  const cashList = getCashHoldings(toAccountId).filter(h => !txSelection || h.id !== txSelection.holdingId);
  if (cashList.length === 0) {
    sel.innerHTML = '<option value="__new__">现金（转账后自动创建）</option>';
    return;
  }
  sel.innerHTML = '<option value="">选择转入基金</option>' +
    cashList.map(h => `<option value="${h.id}">现金（余额 ¥${thousands(h.shares || 0)}）</option>`).join('');
}

// --- Account ---
function handleAddAccount(e) {
  e.preventDefault();
  const name = document.getElementById('acc-name').value.trim();
  if (!name) return showError('请输入账户名称');
  vaultData.accounts.push({ id: crypto.randomUUID(), name });
  saveVault().then(() => { closeModal('modal-account'); renderDashboard(); }).catch(showError);
}

window.deleteAccount = async function(id) {
  if (!confirm('确定删除此账户及其所有持仓和交易记录？')) return;
  vaultData.accounts = vaultData.accounts.filter(a => a.id !== id);
  vaultData.holdings = vaultData.holdings.filter(h => h.accountId !== id);
  vaultData.transactions = vaultData.transactions.filter(t => t.accountId !== id);
  try { await saveVault(); renderDashboard(); } catch(e) { showError(e.message); }
};

window.renameAccount = function(id) {
  const acc = vaultData.accounts.find(a => a.id === id);
  if (!acc) return;
  document.getElementById('rename-acc-id').value = id;
  document.getElementById('rename-acc-name').value = acc.name;
  document.getElementById('modal-rename-account').style.display = 'flex';
};

function handleRenameAccount(e) {
  e.preventDefault();
  const id = document.getElementById('rename-acc-id').value;
  const name = document.getElementById('rename-acc-name').value.trim();
  if (!name) return showError('请输入账户名称');
  const acc = vaultData.accounts.find(a => a.id === id);
  if (!acc) return showError('账户不存在');
  acc.name = name;
  saveVault().then(() => { closeModal('modal-rename-account'); renderDashboard(); }).catch(showError);
}

// --- Image Upload & OCR ---
function setupImageUpload(triggerId, inputId, previewContainerId, previewImgId, type) {
  const trigger = document.getElementById(triggerId);
  const input = document.getElementById(inputId);
  trigger.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return showError('请选择图片文件');
    if (file.size > 20 * 1024 * 1024) return showError('图片不能超过 20MB');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      document.getElementById(previewImgId).src = dataUrl;
      document.getElementById(previewContainerId).style.display = 'block';
      trigger.style.display = 'none';
      processImageOCR(dataUrl, type);
    };
    reader.readAsDataURL(file);
  });
}

function clearImagePreview(type) {
  const prefix = type === 'holding' ? 'holding' : 'tx';
  document.getElementById(`${prefix}-preview`).style.display = 'none';
  document.getElementById(`${prefix}-upload-trigger`).style.display = 'block';
  document.getElementById(`${prefix}-image`).value = '';
}

async function initOCR() {
  if (ocrWorker) return ocrWorker;
  if (ocrLoading) return null;
  ocrLoading = true;
  const loadingEl = document.getElementById('ocr-loading');
  const loadingText = document.getElementById('ocr-loading-text');
  loadingEl.style.display = 'flex';
  loadingText.textContent = '正在加载识别引擎（首次约需 10-30 秒）...';
  try {
    if (typeof Tesseract === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('加载识别引擎失败，请检查网络后重试'));
        document.head.appendChild(script);
      });
    }
    loadingText.textContent = '正在初始化中文识别模型...';
    ocrWorker = await Tesseract.createWorker('chi_sim', 1, {
      logger: (m) => { if (m.status === 'recognizing text') loadingText.textContent = `正在识别... ${Math.round(m.progress * 100)}%`; }
    });
    return ocrWorker;
  } catch (err) {
    console.error('OCR init failed:', err);
    showError('识别引擎加载失败，请检查网络后重试');
    return null;
  }
  finally { loadingEl.style.display = 'none'; ocrLoading = false; }
}

async function processImageOCR(dataUrl, type) {
  const loadingEl = document.getElementById('ocr-loading');
  const loadingText = document.getElementById('ocr-loading-text');
  loadingEl.style.display = 'flex';
  loadingText.textContent = '正在准备识别...';
  try {
    const worker = await initOCR();
    if (!worker) return;
    loadingText.textContent = '正在识别图片内容...';
    const { data } = await worker.recognize(dataUrl);
    const text = data.text || '';
    let parsed = type === 'holding' ? parseHoldingOCR(text) : parseTransactionOCR(text);
    if (type === 'holding') parsed.productType = pendingProductType;
    showOCRConfirmation(parsed, type);
  } catch (err) {
    console.error('OCR failed:', err);
    showError('图片识别失败，请重试或改用手动录入');
  }
  finally { loadingEl.style.display = 'none'; }
}

function parseHoldingOCR(text) {
  const r = { fundCode: '', fundName: '', shares: null, costPerShare: null, currentNav: null };
  const cm = text.match(/(\d{6})/); if (cm) r.fundCode = cm[1];
  const sm = text.match(/(?:份额|持有份额|可用份额|确认份额)[^\d]{0,8}([\d,]+\.?\d*)/); if (sm) r.shares = parseFloat(sm[1].replace(/,/g, ''));
  const costm = text.match(/(?:成本净值|成本价|买入净值|单位成本|持仓成本)[^\d]{0,8}(\d+\.?\d*)/); if (costm) r.costPerShare = parseFloat(costm[1]);
  const nm = text.match(/(?:最新净值|当前净值|单位净值|现净值|净值)[^\d]{0,8}(\d+\.?\d*)/); if (nm) r.currentNav = parseFloat(nm[1]);
  const namem = text.match(/(?:基金名称|基金简称|名称|持有基金)[^\n]{0,5}[:：]\s*(.+)/); if (namem) r.fundName = namem[1].trim().split(/\s/)[0];
  return r;
}

function parseTransactionOCR(text) {
  const r = { fundCode: '', fundName: '', type: 'buy', price: null, amount: null, shares: null };
  const cm = text.match(/(\d{6})/); if (cm) r.fundCode = cm[1];
  if (/赎回|卖出|减仓/.test(text)) r.type = 'sell';
  else if (/买入|申购|认购|加仓/.test(text)) r.type = 'buy';
  else if (/分红|派息/.test(text)) r.type = 'dividend';
  const pm = text.match(/(?:成交价格|成交价|单价|价格|买入净值|申购净值)[^\d]{0,8}(\d+\.?\d*)/); if (pm) r.price = parseFloat(pm[1]);
  const am = text.match(/(?:交易金额|成交金额|确认金额|金额)[^\d]{0,8}([\d,]+\.?\d*)/); if (am) r.amount = parseFloat(am[1].replace(/,/g, ''));
  const sm = text.match(/(?:确认份额|交易份额|成交份额|份额)[^\d]{0,8}([\d,]+\.?\d*)/); if (sm) r.shares = parseFloat(sm[1].replace(/,/g, ''));
  // If price not found but amount and shares found, derive price
  if (r.price == null && r.amount != null && r.shares != null && r.shares > 0) {
    r.price = r.amount / r.shares;
  }
  const namem = text.match(/(?:基金名称|基金简称|名称)[^\n]{0,5}[:：]\s*(.+)/); if (namem) r.fundName = namem[1].trim().split(/\s/)[0];
  return r;
}

function showOCRConfirmation(data, type) {
  ocrMode = type;
  closeModal(type === 'holding' ? 'modal-holding' : 'modal-transaction');
  populateAccountSelect('ocr-account');
  populateProductTypeSelect('ocr-product-type', data.productType || '');
  if (type === 'holding') {
    const srcAcc = document.getElementById('hold-account').value;
    if (srcAcc) document.getElementById('ocr-account').value = srcAcc;
  } else {
    const srcAcc = txSelection?.accountId || '';
    if (srcAcc) document.getElementById('ocr-account').value = srcAcc;
  }
  const holdingFields = document.getElementById('ocr-holding-fields');
  const txFields = document.getElementById('ocr-transaction-fields');
  const ptGroup = document.getElementById('ocr-product-type-group');
  if (type === 'holding') {
    holdingFields.style.display = 'block'; txFields.style.display = 'none'; ptGroup.style.display = 'block';
    document.getElementById('ocr-confirm-title').textContent = '确认持仓识别结果';
    // Toggle cash vs investment fields based on product type
    const isCash = (data.productType || '') === '现金';
    document.getElementById('ocr-cash-group').style.display = isCash ? 'block' : 'none';
    document.getElementById('ocr-investment-fields').style.display = isCash ? 'none' : 'block';
  } else {
    holdingFields.style.display = 'none'; txFields.style.display = 'block'; ptGroup.style.display = 'none';
    document.getElementById('ocr-confirm-title').textContent = '确认交易识别结果';
    // Populate fund dropdown for transaction
    const accId = document.getElementById('ocr-account').value;
    populateTxFundSelect(accId);
    document.getElementById('ocr-tx-fund').value = '';
  }
  document.getElementById('ocr-code').value = data.fundCode || '';
  document.getElementById('ocr-name').value = data.fundName || '';
  if (type === 'holding') {
    if ((data.productType || '') === '现金') {
      document.getElementById('ocr-cash-amount').value = data.shares ?? '';
    } else {
      document.getElementById('ocr-shares').value = data.shares ?? '';
      document.getElementById('ocr-cost').value = data.costPerShare ?? '';
      document.getElementById('ocr-nav').value = data.currentNav ?? '';
    }
  } else {
    document.getElementById('ocr-tx-type').value = data.type || 'buy';
    document.getElementById('ocr-price').value = data.price ?? '';
    document.getElementById('ocr-amount').value = (data.price != null && data.shares != null) ? (data.price * data.shares).toFixed(2) : (data.amount ?? '');
    document.getElementById('ocr-tx-shares').value = data.shares ?? '';
  }
  document.getElementById('ocr-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-ocr-confirm').style.display = 'flex';
}

window.openManualEntry = function(type) {
  ocrMode = type;
  closeModal(type === 'holding' ? 'modal-holding' : 'modal-transaction');
  populateAccountSelect('ocr-account');
  populateProductTypeSelect('ocr-product-type', pendingProductType || '');
  if (type === 'holding') {
    const srcAcc = document.getElementById('hold-account').value;
    if (srcAcc) document.getElementById('ocr-account').value = srcAcc;
    document.getElementById('ocr-holding-fields').style.display = 'block';
    document.getElementById('ocr-transaction-fields').style.display = 'none';
    document.getElementById('ocr-product-type-group').style.display = 'block';
    document.getElementById('ocr-confirm-title').textContent = '手动录入持仓';
    // Toggle cash vs investment fields based on product type
    const isCash = (pendingProductType || '') === '现金';
    document.getElementById('ocr-cash-group').style.display = isCash ? 'block' : 'none';
    document.getElementById('ocr-investment-fields').style.display = isCash ? 'none' : 'block';
  } else {
    const srcAcc = txSelection?.accountId || '';
    if (srcAcc) document.getElementById('ocr-account').value = srcAcc;
    document.getElementById('ocr-holding-fields').style.display = 'none';
    document.getElementById('ocr-transaction-fields').style.display = 'block';
    document.getElementById('ocr-product-type-group').style.display = 'none';
    document.getElementById('ocr-confirm-title').textContent = '手动录入交易';
    // Populate fund dropdown for transaction
    const accId = document.getElementById('ocr-account').value;
    populateTxFundSelect(accId);
    document.getElementById('ocr-tx-fund').value = '';
  }
  ['ocr-code','ocr-name','ocr-shares','ocr-cost','ocr-nav','ocr-price'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ocr-tx-type').value = 'buy';
  document.getElementById('ocr-amount').value = '';
  document.getElementById('ocr-tx-shares').value = '';
  document.getElementById('ocr-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-ocr-confirm').style.display = 'flex';
};

function handleOCRConfirm(e) {
  e.preventDefault();
  try {
    const accountId = document.getElementById('ocr-account').value;
    if (!accountId) return showError('请选择账户');
    const date = document.getElementById('ocr-date').value;
    if (!date) return showError('请选择日期');

    if (ocrMode === 'holding') {
      const productType = document.getElementById('ocr-product-type').value;
      if (!productType) return showError('请选择产品类型');

      if (productType === '现金') {
        const cashAmount = parseFloat(document.getElementById('ocr-cash-amount').value);
        if (isNaN(cashAmount) || cashAmount < 0) return showError('请填写现金金额');
        vaultData.holdings.push({ id: crypto.randomUUID(), accountId, productType, fundCode: '', fundName: '', shares: cashAmount, costPerShare: 1, currentNav: 1, date });
      } else {
        const fundCode = document.getElementById('ocr-code').value.trim();
        const fundName = document.getElementById('ocr-name').value.trim();
        if (!fundName) return showError('请填写基金名称');
        let shares = parseFloat(document.getElementById('ocr-shares').value);
        let costPerShare = parseFloat(document.getElementById('ocr-cost').value);
        let currentNav = parseFloat(document.getElementById('ocr-nav').value);

        // If shares or cost not provided, try to calculate from transactions
        if (isNaN(shares) || isNaN(costPerShare)) {
          const txCalc = calculateSharesAndCostFromTransactions(accountId, fundCode, fundName);
          if (isNaN(shares)) shares = txCalc.shares;
          if (isNaN(costPerShare)) costPerShare = txCalc.costPerShare;
        }

        // Default to 0 if still not available
        if (isNaN(shares)) shares = 0;
        if (isNaN(costPerShare)) costPerShare = 0;
        if (isNaN(currentNav)) currentNav = costPerShare || 0;

        vaultData.holdings.push({ id: crypto.randomUUID(), accountId, productType, fundCode, fundName, shares, costPerShare, currentNav, date });
      }
    } else {
      const fundName = document.getElementById('ocr-tx-fund').value;
      if (!fundName) return showError('请选择基金');
      const selectedOption = document.getElementById('ocr-tx-fund').options[document.getElementById('ocr-tx-fund').selectedIndex];
      const fundCode = document.getElementById('ocr-code').value.trim() || selectedOption.dataset.fundCode || '';
      const type = document.getElementById('ocr-tx-type').value;
      const price = parseFloat(document.getElementById('ocr-price').value);
      if (isNaN(price)) return showError('请填写价格');
      const shares = parseFloat(document.getElementById('ocr-tx-shares').value);
      if (isNaN(shares)) return showError('请填写交易份额');
      const amount = price * shares;
      const err = applyTransactionEffects({ accountId, fundCode, fundName, type, price, shares });
      if (err) return showError(err);
      vaultData.transactions.push({ id: crypto.randomUUID(), accountId, fundCode, fundName, type, price, amount, shares, date });
    }
    closeModal('modal-ocr-confirm');
    saveVault().then(() => renderDashboard()).catch(showError);
  } catch (err) {
    showError(err && err.message ? err.message : '操作失败，请稍后重试');
  }
}

function handleAddTransaction(e) {
  e.preventDefault();
  if (!txSelection) return showError('请先选择账户和基金');
  const today = new Date().toISOString().split('T')[0];

  if (txSelection.isCash) {
    // Transfer: source cash holding -> target cash holding
    const amount = parseFloat(document.getElementById('tx-transfer-amount').value);
    if (isNaN(amount) || amount <= 0) return showError('请填写转账金额');
    const toAccountId = document.getElementById('tx-to-account').value;
    if (!toAccountId) return showError('请选择转入账户');
    const toFundValue = document.getElementById('tx-to-fund').value;
    if (!toFundValue) return showError('请选择转入基金');
    const date = document.getElementById('tx-transfer-date').value || today;
    const srcCash = vaultData.holdings.find(h => h.id === txSelection.holdingId);
    if (!srcCash) return showError('现金持仓不存在');
    if ((srcCash.shares || 0) + EPSILON < amount) return showError('现金不足');

    srcCash.shares = roundMoney((srcCash.shares || 0) - amount);
    if (toFundValue === '__new__') {
      vaultData.holdings.push(makeCashHolding(toAccountId, amount, date));
    } else {
      const toHolding = vaultData.holdings.find(h => h.id === toFundValue);
      if (!toHolding) return showError('转入基金不存在');
      toHolding.shares = roundMoney((toHolding.shares || 0) + amount);
    }
    vaultData.transactions.push({ id: crypto.randomUUID(), accountId: txSelection.accountId, fundCode: '', fundName: '现金', type: 'transfer', price: null, shares: null, amount, date, toAccountId });
  } else {
    const type = document.getElementById('tx-type').value;
    const price = parseFloat(document.getElementById('tx-price').value);
    if (isNaN(price)) return showError('请填写价格');
    const shares = parseFloat(document.getElementById('tx-shares').value);
    if (isNaN(shares) || shares <= 0) return showError('请填写正确的交易份额');
    const date = document.getElementById('tx-date').value || today;
    const err = applyTransactionEffects({ accountId: txSelection.accountId, fundCode: txSelection.fundCode, fundName: txSelection.fundName, type, price, shares });
    if (err) return showError(err);
    vaultData.transactions.push({ id: crypto.randomUUID(), accountId: txSelection.accountId, fundCode: txSelection.fundCode, fundName: txSelection.fundName, type, price, amount: price * shares, shares, date });
  }

  closeModal('modal-transaction');
  // Reset form
  document.getElementById('form-transaction').reset();
  document.getElementById('tx-upload-area').style.display = 'none';
  saveVault().then(() => renderDashboard()).catch(showError);
}

// --- Edit Transaction ---
window.editTransaction = function(id) {
  const t = vaultData.transactions.find(x => x.id === id);
  if (!t) return showError('交易记录不存在');

  populateAccountSelect('edit-tx-account');
  document.getElementById('edit-tx-id').value = t.id;
  document.getElementById('edit-tx-account').value = t.accountId;
  document.getElementById('edit-tx-type').value = t.type;
  document.getElementById('edit-tx-price').value = t.price ?? '';
  document.getElementById('edit-tx-shares').value = t.shares;
  document.getElementById('edit-tx-amount').value = (t.price != null && t.shares != null) ? (t.price * t.shares).toFixed(2) : '';
  document.getElementById('edit-tx-date').value = t.date;

  // Populate fund dropdown for this account
  const editFundSel = document.getElementById('edit-tx-fund');
  editFundSel.innerHTML = '<option value="">选择持仓基金</option>';
  const holdings = (vaultData?.holdings || []).filter(h => h.accountId === t.accountId && h.productType !== '现金');
  const seen = new Set();
  holdings.forEach(h => {
    if (!h.fundName || seen.has(h.fundName)) return;
    seen.add(h.fundName);
    const label = h.fundCode ? `${h.fundName} (${h.fundCode})` : h.fundName;
    const opt = document.createElement('option');
    opt.value = h.fundName;
    opt.textContent = label;
    opt.dataset.fundCode = h.fundCode || '';
    editFundSel.appendChild(opt);
  });
  editFundSel.value = t.fundName;

  document.getElementById('modal-edit-transaction').style.display = 'flex';
};

function handleEditTransaction(e) {
  e.preventDefault();
  const id = document.getElementById('edit-tx-id').value;
  const t = vaultData.transactions.find(x => x.id === id);
  if (!t) return showError('交易记录不存在');

  const accountId = document.getElementById('edit-tx-account').value;
  if (!accountId) return showError('请选择账户');
  const fundName = document.getElementById('edit-tx-fund').value;
  if (!fundName) return showError('请选择基金');
  const selectedOption = document.getElementById('edit-tx-fund').options[document.getElementById('edit-tx-fund').selectedIndex];
  const fundCode = selectedOption.dataset.fundCode || '';
  const type = document.getElementById('edit-tx-type').value;
  const price = parseFloat(document.getElementById('edit-tx-price').value);
  if (isNaN(price)) return showError('请填写价格');
  const shares = parseFloat(document.getElementById('edit-tx-shares').value);
  if (isNaN(shares)) return showError('请填写交易份额');
  const amount = price * shares;
  const date = document.getElementById('edit-tx-date').value;
  if (!date) return showError('请选择日期');

  t.accountId = accountId;
  t.fundCode = fundCode;
  t.fundName = fundName;
  t.type = type;
  t.price = price;
  t.shares = shares;
  t.amount = amount;
  t.date = date;

  saveVault()
    .then(() => { closeModal('modal-edit-transaction'); renderDashboard(); })
    .catch(showError);
}

function handleCsvImport(e) {
  e.preventDefault();
  const file = document.getElementById('csv-file').files[0];
  const accountId = document.getElementById('csv-account').value;
  const importType = document.getElementById('csv-type').value;
  if (!file || !accountId) return showError('请选择文件和账户');
  const reader = new FileReader();
  reader.onload = async function(ev) {
    try {
      const text = ev.target.result;
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return showError('CSV 文件为空');
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      const rows = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim());
        return Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
      });
      if (importType === 'holdings') {
        rows.forEach(r => {
          const fundCode = r['基金代码'] || r['代码'] || r['code'] || '';
          const fundName = r['基金名称'] || r['名称'] || r['name'] || '';
          const shares = parseFloat(r['份额'] || r['shares'] || '0');
          const costPerShare = parseFloat(r['成本净值'] || r['成本'] || r['cost'] || '0');
          const currentNav = parseFloat(r['最新净值'] || r['净值'] || r['nav'] || costPerShare);
          if (fundName && shares > 0) vaultData.holdings.push({ id: crypto.randomUUID(), accountId, fundCode, fundName, shares, costPerShare, currentNav, date: new Date().toISOString().split('T')[0] });
        });
      } else {
        rows.forEach(r => {
          const fundCode = r['基金代码'] || r['代码'] || r['code'] || '';
          const fundName = r['基金名称'] || r['名称'] || r['name'] || '';
          const type = r['类型'] || r['type'] || 'buy';
          const amount = parseFloat(r['金额'] || r['amount'] || '0');
          const shares = parseFloat(r['份额'] || r['shares'] || '0');
          const date = r['日期'] || r['date'] || '';
          if (fundName && date) vaultData.transactions.push({ id: crypto.randomUUID(), accountId, fundCode, fundName, type, amount, shares, date });
        });
      }
      await saveVault();
      closeModal('modal-csv');
      renderDashboard();
      showError('导入成功！');
    } catch (err) {
      console.error('CSV import failed:', err);
      showError('CSV 文件解析失败，请检查文件格式后重试');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

// --- Quick Daily Entry (今日快录) ---
let quickNavSeries = new Map(); // fundCode -> Map(dateStr -> nav)

function openQuickEntry() {
  if (!vaultData) return;
  quickNavSeries = new Map();
  document.getElementById('quick-fetch-status').textContent = '';
  const dateInput = document.getElementById('quick-date');
  const today = new Date().toISOString().split('T')[0];
  dateInput.value = today;
  dateInput.max = today;
  renderQuickList();
  openModal('modal-quick');
}

function renderQuickList() {
  const container = document.getElementById('quick-list');
  const { accounts, holdings } = vaultData;
  const investHoldings = holdings.filter(h => h.productType !== '现金');
  if (investHoldings.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无非现金持仓，请先在「持仓明细」添加基金</div>';
    return;
  }
  container.innerHTML = accounts.map(acc => {
    const rows = investHoldings.filter(h => h.accountId === acc.id);
    if (rows.length === 0) return '';
    return `
      <div class="quick-group">
        <div class="quick-group-title">${esc(acc.name)}</div>
        ${rows.map(h => `
          <div class="quick-row" data-id="${h.id}">
            <div class="quick-fund">
              <span class="quick-fund-name">${esc(h.fundName || '未命名')}${h.fundCode ? ` <span class="quick-fund-code">${esc(h.fundCode)}</span>` : ''}</span>
              <span class="quick-delta" id="quick-delta-${h.id}"></span>
            </div>
            <div class="quick-inputs">
              <label>份额<input type="number" step="0.01" inputmode="decimal" data-id="${h.id}" data-field="shares" placeholder="${h.shares ?? '—'}"></label>
              <label>成本<input type="number" step="0.0001" inputmode="decimal" data-id="${h.id}" data-field="cost" placeholder="${h.costPerShare ?? '—'}"></label>
              <label>现价<input type="number" step="0.0001" inputmode="decimal" data-id="${h.id}" data-field="nav" placeholder="${h.currentNav ?? '—'}"></label>
            </div>
          </div>`).join('')}
      </div>`;
  }).join('');
}

function updateQuickDelta(input) {
  const row = input.closest('.quick-row');
  if (!row) return;
  const id = row.dataset.id;
  const h = (vaultData?.holdings || []).find(x => x.id === id);
  const el = document.getElementById('quick-delta-' + id);
  if (!h || !el) return;
  const navInput = row.querySelector('[data-field="nav"]');
  const v = parseFloat(navInput.value);
  if (!navInput.value || isNaN(v) || !h.currentNav) { el.textContent = ''; return; }
  const pct = (v - h.currentNav) / h.currentNav * 100;
  const money = (h.shares || 0) * (v - h.currentNav);
  el.textContent = `${pct >= 0 ? '↗ +' : '↘ '}${pct.toFixed(2)}%  ${money >= 0 ? '+' : ''}¥${thousands(money)}`;
  el.className = 'quick-delta ' + (pct >= 0 ? 'positive' : 'negative');
}

async function handleQuickSave(e) {
  e.preventDefault();
  if (!vaultData) return;
  const btn = document.getElementById('quick-submit');
  const dateStr = document.getElementById('quick-date').value || new Date().toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const isPast = dateStr < today; // 补录过去：只写历史趋势点，不改当前现价
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    let changed = 0;
    const navOverrides = new Map();
    document.querySelectorAll('#quick-list input[data-field]').forEach(input => {
      if (input.value === '') return;
      const v = parseFloat(input.value);
      if (isNaN(v) || v < 0) return;
      const h = vaultData.holdings.find(x => x.id === input.dataset.id);
      if (!h) return;
      if (input.dataset.field === 'cost') {
        h.costPerShare = v;
      } else if (input.dataset.field === 'shares') {
        h.shares = v; // 份额是当前持仓事实，无论补录哪天都直接生效
      } else if (isPast) {
        navOverrides.set(h.id, v);
      } else {
        h.currentNav = v;
      }
      if (!isPast) h.date = dateStr; // 录今天：持仓日期同步为本次数据更新日期
      changed++;
    });
    if (changed > 0) {
      backfillSnapshots(dateStr); // 先补历史缺口，再写所选日期当天的快照
      upsertSnapshot(buildSnapshot(dateStr, isPast ? navOverrides : null));
      await persistVault();
      renderDashboard();
    }
    closeModal('modal-quick');
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

// 用已拉取的净值序列，把「上次快照之后 ~ 所选日期」之间缺失的交易日快照补上。
// 历史快照按当前份额近似计算（若期间有过交易，最早的原快照不受影响）。
function backfillSnapshots(uptoDate) {
  const snaps = vaultData.snapshots || [];
  const earlierDates = snaps.filter(s => s.date <= uptoDate).map(s => s.date).sort();
  const anchor = earlierDates.length ? earlierDates[earlierDates.length - 1] : null;
  if (!anchor) return; // 没有更早的快照作锚点，不回补
  const min = new Date(uptoDate + 'T00:00:00Z');
  min.setUTCDate(min.getUTCDate() - 90);
  const minDate = min.toISOString().split('T')[0];
  const from = anchor > minDate ? anchor : minDate;

  const tradingDays = new Set();
  quickNavSeries.forEach(series => {
    series.forEach((nav, d) => { if (d > from && d <= uptoDate) tradingDays.add(d); });
  });
  if (tradingDays.size === 0) return;

  const existing = new Set(snaps.map(s => s.date));
  const { accounts, holdings } = vaultData;
  [...tradingDays].sort().forEach(d => {
    if (existing.has(d)) return;
    let totalValue = 0, totalCost = 0;
    const items = holdings.map(h => {
      const shares = h.shares || 0;
      let nav = h.currentNav || 0;
      const series = quickNavSeries.get(h.fundCode);
      if (series && series.has(d)) nav = series.get(d);
      totalValue += shares * nav;
      totalCost += shares * (h.costPerShare || 0);
      const acc = accounts.find(a => a.id === h.accountId);
      return { accountId: h.accountId, accountName: acc?.name || '未知', productType: h.productType || '', fundName: h.fundName, shares, costPerShare: h.costPerShare || 0, currentNav: nav };
    });
    snaps.push({ date: d, totalValue, totalCost, holdings: items });
    existing.add(d);
  });
  vaultData.snapshots.sort((a, b) => a.date.localeCompare(b.date));
}

// 从天天基金公开数据加载净值序列（script 注入绕过跨域，不涉及 CORS 配置）
function fetchNavSeries(code) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 10000);
    function cleanup() {
      clearTimeout(timer);
      script.remove();
      try { delete window.Data_netWorthTrend; } catch { window.Data_netWorthTrend = undefined; }
    }
    script.src = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
    script.onload = () => {
      try {
        const trend = window.Data_netWorthTrend;
        if (!Array.isArray(trend) || trend.length === 0) throw new Error('no data');
        const series = new Map();
        trend.slice(-200).forEach(p => {
          // p.x 为 UTC 毫秒时间戳，按东八区日历日归档
          const d = new Date(p.x + 8 * 3600 * 1000).toISOString().split('T')[0];
          series.set(d, p.y);
        });
        cleanup();
        resolve(series);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    script.onerror = () => { cleanup(); reject(new Error('load failed')); };
    document.head.appendChild(script);
  });
}

async function handleQuickFetch() {
  const btn = document.getElementById('btn-quick-fetch');
  const status = document.getElementById('quick-fetch-status');
  const candidates = (vaultData?.holdings || []).filter(h => h.productType !== '现金' && h.fundCode);
  const noCode = (vaultData?.holdings || []).filter(h => h.productType !== '现金' && !h.fundCode).length;
  if (candidates.length === 0) {
    status.textContent = '没有带基金代码的持仓，请手动填写现价';
    return;
  }
  btn.disabled = true;
  btn.textContent = '补全中...';
  status.textContent = '正在从天天基金拉取净值...';
  const codes = [...new Set(candidates.map(h => h.fundCode))];
  let ok = 0, fail = 0;
  for (const code of codes) {
    try {
      const series = await fetchNavSeries(code);
      quickNavSeries.set(code, series);
      let lastNav = null;
      series.forEach(v => { lastNav = v; });
      candidates.filter(h => h.fundCode === code).forEach(h => {
        const input = document.querySelector(`#quick-list input[data-id="${h.id}"][data-field="nav"]`);
        if (input && lastNav != null) {
          input.value = lastNav;
          updateQuickDelta(input);
        }
      });
      ok++;
    } catch {
      fail++;
    }
  }
  status.textContent = `补全完成：成功 ${ok} 只${fail ? `，失败 ${fail} 只（代码不存在或网络受限）` : ''}${noCode ? `，另有 ${noCode} 只无基金代码需手动填` : ''}。已填入最新官方净值，请核对后保存。`;
  btn.disabled = false;
  btn.textContent = '联网补全净值';
}

// --- Journal: 投资警示录 ---
function renderJournal() {
  const list = document.getElementById('journal-list');
  const entries = [...(vaultData?.journal || [])].sort((a, b) =>
    b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">还没有记录。市场给你的每个教训，都值得记下来。</div>';
    return;
  }
  list.innerHTML = entries.map(en => `
    <div class="journal-item ${en.type === '警示' ? 'journal-warn' : 'journal-note'}">
      <div class="journal-meta">
        <span class="journal-badge">${en.type === '警示' ? '⚠️ 警示' : '💡 心得'}</span>
        <span class="journal-date">${esc(en.date)}</span>
        <button class="btn-icon" onclick="deleteJournal('${en.id}')" title="删除">×</button>
      </div>
      <div class="journal-text">${esc(en.text)}</div>
    </div>`).join('');
}

async function handleAddJournal(e) {
  e.preventDefault();
  if (!vaultData) return;
  const text = document.getElementById('journal-text').value.trim();
  if (!text) return showError('写点内容再记吧');
  vaultData.journal.push({
    id: crypto.randomUUID(),
    type: document.getElementById('journal-type').value,
    date: document.getElementById('journal-date').value || new Date().toISOString().split('T')[0],
    text,
    createdAt: new Date().toISOString(),
  });
  document.getElementById('journal-text').value = '';
  try {
    await persistVault();
    renderJournal();
  } catch (err) {
    showError(err.message);
  }
}

window.deleteJournal = async function(id) {
  if (!confirm('删除这条记录？')) return;
  vaultData.journal = (vaultData.journal || []).filter(j => j.id !== id);
  try { await persistVault(); renderJournal(); } catch (err) { showError(err.message); }
};

function handleLogout() {
  vaultData = null; currentPassword = null; vaultId = null;
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

// --- 金额显隐 ---
window.togglePrivacy = function() {
  privacyMode = !privacyMode;
  try { localStorage.setItem('fv-privacy', privacyMode ? '1' : '0'); } catch {}
  updatePrivacyButton();
  if (vaultData) renderDashboard();
};

function updatePrivacyButton() {
  const btn = document.getElementById('privacy-toggle');
  if (!btn) return;
  btn.textContent = privacyMode ? '🙈' : '👁';
  btn.title = privacyMode ? '金额已隐藏，点击显示' : '隐藏金额，防止旁人看到';
}

// --- Init ---
updatePrivacyButton();
document.getElementById('auth-form').addEventListener('submit', handleAuth);
document.getElementById('form-account').addEventListener('submit', handleAddAccount);
document.getElementById('form-rename-account').addEventListener('submit', handleRenameAccount);
document.getElementById('form-edit-holding').addEventListener('submit', handleEditHolding);
document.getElementById('form-ocr-confirm').addEventListener('submit', handleOCRConfirm);
document.getElementById('form-transaction').addEventListener('submit', handleAddTransaction);
document.getElementById('form-edit-transaction').addEventListener('submit', handleEditTransaction);
document.getElementById('form-csv').addEventListener('submit', handleCsvImport);
document.getElementById('btn-logout').addEventListener('click', handleLogout);
document.getElementById('btn-quick').addEventListener('click', openQuickEntry);
document.getElementById('form-quick').addEventListener('submit', handleQuickSave);
document.getElementById('btn-quick-fetch').addEventListener('click', handleQuickFetch);
document.getElementById('form-journal').addEventListener('submit', handleAddJournal);
document.getElementById('holding-filter').addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  holdingFilter = chip.dataset.acc;
  renderHoldings(vaultData.holdings, vaultData.accounts);
});

// 持仓总金额排序：默认顺序 → 从高到低 → 从低到高 → 默认
window.toggleHoldingSort = function() {
  holdingSort = holdingSort === '' ? 'desc' : holdingSort === 'desc' ? 'asc' : '';
  renderHoldings(vaultData.holdings, vaultData.accounts);
};

// 快录列表：实时涨跌显示 + 回车跳下一行（最后一行回车=提交）
const quickListEl = document.getElementById('quick-list');
quickListEl.addEventListener('input', e => {
  if (e.target.matches('input[data-field]')) updateQuickDelta(e.target);
});
quickListEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('input[data-field]')) return;
  e.preventDefault();
  const inputs = [...quickListEl.querySelectorAll('input[data-field]')];
  const idx = inputs.indexOf(e.target);
  if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
  else document.getElementById('form-quick').requestSubmit();
});

document.getElementById('hold-account').addEventListener('change', checkHoldingUploadVisibility);
document.getElementById('hold-product-type').addEventListener('change', checkHoldingUploadVisibility);
document.getElementById('tx-to-account').addEventListener('change', function() {
  populateToFundSelect(this.value);
});

// Auto-calculate amount when price or shares change
document.getElementById('tx-price').addEventListener('input', () => calcTxAmount('tx-price', 'tx-shares', 'tx-amount'));
document.getElementById('tx-shares').addEventListener('input', () => calcTxAmount('tx-price', 'tx-shares', 'tx-amount'));
document.getElementById('ocr-price').addEventListener('input', () => calcTxAmount('ocr-price', 'ocr-tx-shares', 'ocr-amount'));
document.getElementById('ocr-tx-shares').addEventListener('input', () => calcTxAmount('ocr-price', 'ocr-tx-shares', 'ocr-amount'));
document.getElementById('edit-tx-price').addEventListener('input', () => calcTxAmount('edit-tx-price', 'edit-tx-shares', 'edit-tx-amount'));
document.getElementById('edit-tx-shares').addEventListener('input', () => calcTxAmount('edit-tx-price', 'edit-tx-shares', 'edit-tx-amount'));

// Update fund dropdown when edit-tx-account changes
document.getElementById('edit-tx-account').addEventListener('change', function() {
  const editFundSel = document.getElementById('edit-tx-fund');
  editFundSel.innerHTML = '<option value="">选择持仓基金</option>';
  const accountId = this.value;
  if (!accountId) return;
  const holdings = (vaultData?.holdings || []).filter(h => h.accountId === accountId && h.productType !== '现金');
  const seen = new Set();
  holdings.forEach(h => {
    if (!h.fundName || seen.has(h.fundName)) return;
    seen.add(h.fundName);
    const label = h.fundCode ? `${h.fundName} (${h.fundCode})` : h.fundName;
    const opt = document.createElement('option');
    opt.value = h.fundName;
    opt.textContent = label;
    opt.dataset.fundCode = h.fundCode || '';
    editFundSel.appendChild(opt);
  });
});

// Toggle cash vs investment fields in edit modal
document.getElementById('edit-holding-product-type').addEventListener('change', function() {
  const isCash = this.value === '现金';
  document.getElementById('edit-cash-group').style.display = isCash ? 'block' : 'none';
  document.getElementById('edit-investment-fields').style.display = isCash ? 'none' : 'block';
});

// Toggle cash vs investment fields in OCR modal
document.getElementById('ocr-product-type').addEventListener('change', function() {
  const isCash = this.value === '现金';
  document.getElementById('ocr-cash-group').style.display = isCash ? 'block' : 'none';
  document.getElementById('ocr-investment-fields').style.display = isCash ? 'none' : 'block';
});

// Update fund dropdown when OCR account changes
document.getElementById('ocr-account').addEventListener('change', function() {
  const txFields = document.getElementById('ocr-transaction-fields');
  if (txFields.style.display !== 'none') {
    populateTxFundSelect(this.value);
    document.getElementById('ocr-tx-fund').value = '';
  }
});

// Auto-fill fund code when fund is selected in transaction modal
document.getElementById('ocr-tx-fund').addEventListener('change', function() {
  const fundName = this.value;
  if (!fundName) {
    document.getElementById('ocr-code').value = '';
    document.getElementById('ocr-name').value = '';
    return;
  }
  const selectedOption = this.options[this.selectedIndex];
  const fundCode = selectedOption.dataset.fundCode || '';
  document.getElementById('ocr-code').value = fundCode;
  document.getElementById('ocr-name').value = fundName;
});

setupImageUpload('holding-upload-trigger', 'holding-image', 'holding-preview', 'holding-preview-img', 'holding');
setupImageUpload('tx-upload-trigger', 'tx-image', 'tx-preview', 'tx-preview-img', 'transaction');

// Resize chart on window resize
// 资产配置日期切换
document.getElementById('allocation-date').addEventListener('change', function() {
  allocationDate = this.value;
  renderAllocation();
});

window.addEventListener('resize', () => { if (vaultData) { renderTrendChart(); renderAllocation(); } });

function switchAuthMode(mode) {
  const form = document.getElementById('auth-form');
  form.dataset.mode = mode;
  document.getElementById('confirm-group').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('auth-title').textContent = mode === 'register' ? '注册新金库' : '解锁金库';
  document.getElementById('auth-submit').textContent = mode === 'register' ? '注册' : '登录';
  document.getElementById('switch-link').textContent = mode === 'register' ? '已有账户？去登录' : '没有账户？去注册';
}
window.switchAuthMode = switchAuthMode;
window.openModal = openModal;
window.closeModal = closeModal;
window.clearImagePreview = clearImagePreview;
