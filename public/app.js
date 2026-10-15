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

const PRODUCT_TYPES = ['股票型基金', '债券型基金', '现金', '理财', '股票', '期权'];

// Calculate average cost per share from transactions for a specific holding
function calculateCostFromTransactions(holding, transactions) {
  // Match transactions by fundCode or fundName + accountId
  const matchingTx = transactions.filter(t => {
    if (t.accountId !== holding.accountId) return false;
    if (holding.fundCode && t.fundCode) return t.fundCode === holding.fundCode;
    return t.fundName === holding.fundName;
  });

  if (matchingTx.length === 0) return null;

  // Sort by date
  const sorted = [...matchingTx].sort((a, b) => a.date.localeCompare(b.date));

  let totalShares = 0;
  let totalCost = 0;

  for (const tx of sorted) {
    if (tx.type === 'buy') {
      totalShares += tx.shares;
      totalCost += tx.amount;
    } else if (tx.type === 'sell') {
      // On sell, reduce shares but keep average cost the same
      if (totalShares > 0) {
        const avgCost = totalCost / totalShares;
        totalShares -= tx.shares;
        totalCost = totalShares * avgCost;
      }
    }
    // dividend doesn't affect cost basis
  }

  if (totalShares <= 0) return null;
  return totalCost / totalShares;
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
async function api(action, body = null) {
  const opts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const url = body ? `${API_BASE}?action=${action}` : `${API_BASE}?action=${action}&id=${vaultId}`;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
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
      const emptyVault = JSON.stringify({ accounts: [], holdings: [], transactions: [], snapshots: [] });
      const encrypted = await encrypt(emptyVault, password);
      const result = await api('register', { passwordHash: pwHash, encryptedData: encrypted });
      if (result.error) throw new Error(result.error);
      vaultId = result.id;
      currentPassword = password;
      vaultData = JSON.parse(emptyVault);
    } else {
      const result = await api('login', { passwordHash: pwHash });
      if (result.error) throw new Error(result.error === 'not_found' ? '未找到数据，请先注册' : '密码错误');
      vaultId = result.id;
      try {
        const decrypted = await decrypt(result.encryptedData, password);
        vaultData = JSON.parse(decrypted);
        // Data migration: add snapshots array for old vaults
        if (!vaultData.snapshots) vaultData.snapshots = [];
        currentPassword = password;
      } catch {
        throw new Error('密码错误');
      }
    }
    showDashboard();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = isRegister ? '注册' : '登录';
  }
}

// --- Snapshot ---
function captureSnapshot() {
  if (!vaultData || !vaultData.holdings || vaultData.holdings.length === 0) return;
  const today = new Date().toISOString().split('T')[0];
  const { accounts, holdings, transactions } = vaultData;

  let totalValue = 0, totalCost = 0;
  const items = holdings.map(h => {
    const value = h.shares * h.currentNav;
    const txCalc = calculateSharesAndCostFromTransactions(h.accountId, h.fundCode, h.fundName);
    const hasTxData = !isNaN(txCalc.shares) && txCalc.shares > 0;
    const shares = hasTxData ? txCalc.shares : h.shares;
    const costPerShare = hasTxData ? txCalc.costPerShare : h.costPerShare;
    const cost = shares * costPerShare;
    totalValue += value;
    totalCost += cost;
    const acc = accounts.find(a => a.id === h.accountId);
    return { accountId: h.accountId, accountName: acc?.name || '未知', productType: h.productType || '', fundName: h.fundName, shares: shares, costPerShare: costPerShare, currentNav: h.currentNav };
  });

  const snapshot = { date: today, totalValue, totalCost, holdings: items };
  const existingIdx = vaultData.snapshots.findIndex(s => s.date === today);
  if (existingIdx >= 0) {
    vaultData.snapshots[existingIdx] = snapshot;
  } else {
    vaultData.snapshots.push(snapshot);
  }
}

// --- Save ---
async function saveVault() {
  if (!vaultData || !currentPassword) return;
  captureSnapshot();
  const plaintext = JSON.stringify(vaultData);
  const encrypted = await encrypt(plaintext, currentPassword);
  const result = await api('save', { id: vaultId, encryptedData: encrypted });
  if (result.error) throw new Error(result.error);
}

// --- Render ---
function showError(msg) {
  const el = document.getElementById('error-msg');
  if (!el) { alert(msg); return; }
  el.textContent = msg;
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

function renderDashboard() {
  const { accounts, holdings, transactions } = vaultData;
  let totalAssets = 0, totalCost = 0, cashTotal = 0, investTotal = 0;

  holdings.forEach(h => {
    const value = h.shares * h.currentNav;
    // Use calculated shares and cost from transactions if available
    const txCalc = calculateSharesAndCostFromTransactions(h.accountId, h.fundCode, h.fundName);
    const hasTxData = !isNaN(txCalc.shares) && txCalc.shares > 0;
    const shares = hasTxData ? txCalc.shares : h.shares;
    const costPerShare = hasTxData ? txCalc.costPerShare : h.costPerShare;
    const cost = shares * costPerShare;
    totalAssets += value;
    totalCost += cost;
    if (h.productType === '现金') {
      cashTotal += value;
    } else {
      investTotal += value;
    }
  });

  const totalPnl = totalAssets - totalCost;
  const totalPnlRate = totalCost > 0 ? (totalPnl / totalCost * 100).toFixed(2) : '0.00';

  document.getElementById('total-assets').textContent = `¥${totalAssets.toFixed(2)}`;
  document.getElementById('total-pnl').textContent = `${totalPnl >= 0 ? '+' : ''}¥${totalPnl.toFixed(2)}`;
  document.getElementById('total-pnl').className = totalPnl >= 0 ? 'positive' : 'negative';
  document.getElementById('total-pnl-rate').textContent = `${totalPnl >= 0 ? '+' : ''}${totalPnlRate}%`;
  document.getElementById('total-pnl-rate').className = totalPnl >= 0 ? 'positive' : 'negative';
  document.getElementById('account-count').textContent = accounts.length;
  document.getElementById('cash-total').textContent = `¥${cashTotal.toFixed(2)}`;
  document.getElementById('invest-total').textContent = `¥${investTotal.toFixed(2)}`;

  renderAccounts(accounts, holdings, transactions);
  renderHoldings(holdings, accounts);
  renderTransactions(transactions, accounts);
  renderTrendChart();
  renderHistory();
}

function renderAccounts(accounts, holdings, transactions) {
  const container = document.getElementById('accounts-list');
  if (accounts.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无账户，请添加基金账户</div>';
    return;
  }
  container.innerHTML = accounts.map(acc => {
    const accHoldings = holdings.filter(h => h.accountId === acc.id);
    const accValue = accHoldings.reduce((sum, h) => sum + h.shares * h.currentNav, 0);
    const accCost = accHoldings.reduce((sum, h) => {
      const txCalc = calculateSharesAndCostFromTransactions(h.accountId, h.fundCode, h.fundName);
      const hasTxData = !isNaN(txCalc.shares) && txCalc.shares > 0;
      const shares = hasTxData ? txCalc.shares : h.shares;
      const costPerShare = hasTxData ? txCalc.costPerShare : h.costPerShare;
      return sum + shares * costPerShare;
    }, 0);
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
          <span>资产: ¥${accValue.toFixed(2)}</span>
          <span class="${accPnl >= 0 ? 'positive' : 'negative'}">收益: ${accPnl >= 0 ? '+' : ''}¥${accPnl.toFixed(2)}</span>
        </div>
      </div>`;
  }).join('');
}

function renderHoldings(holdings, accounts) {
  const tbody = document.getElementById('holdings-tbody');
  if (holdings.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">暂无持仓数据</td></tr>';
    return;
  }
  const transactions = vaultData?.transactions || [];
  tbody.innerHTML = holdings.map(h => {
    const acc = accounts.find(a => a.id === h.accountId);
    const isCash = h.productType === '现金';
    const marketValue = h.shares * h.currentNav;

    // Calculate shares and cost from transactions if available
    const txCalc = calculateSharesAndCostFromTransactions(h.accountId, h.fundCode, h.fundName);
    const hasTxData = !isNaN(txCalc.shares) && txCalc.shares > 0;
    const displayShares = hasTxData ? txCalc.shares : h.shares;
    const costPerShare = hasTxData ? txCalc.costPerShare : h.costPerShare;
    const calcCost = hasTxData ? costPerShare : null;

    const costValue = displayShares * costPerShare;
    const pnl = marketValue - costValue;
    const pnlRate = costValue > 0 ? (pnl / costValue * 100).toFixed(2) : '0.00';
    const name = isCash ? (h.fundName || '现金') : h.fundName;

    if (isCash) {
      return `
        <tr>
          <td>${esc(acc?.name || '未知')}</td>
          <td><span class="product-type-tag cash-tag">${esc(h.productType)}</span></td>
          <td>${esc(name)}</td>
          <td colspan="3" class="cash-amount-cell">¥${marketValue.toFixed(2)}</td>
          <td>-</td>
          <td>${h.date || '-'}</td>
          <td><button class="btn-edit" onclick="editHolding('${h.id}')">编辑</button></td>
        </tr>`;
    }
    const costLabel = calcCost !== null ? `${costPerShare.toFixed(4)} <span class="cost-calculated">(交易计算)</span>` : costPerShare.toFixed(4);
    const sharesLabel = hasTxData ? `${displayShares.toFixed(2)} <span class="cost-calculated">(交易计算)</span>` : displayShares.toFixed(2);
    return `
      <tr>
        <td>${esc(acc?.name || '未知')}</td>
        <td><span class="product-type-tag">${esc(h.productType || '-')}</span></td>
        <td>${esc(h.fundName)}</td>
        <td>${sharesLabel}</td>
        <td>${costLabel}</td>
        <td>${h.currentNav.toFixed(4)}</td>
        <td class="${pnl >= 0 ? 'positive' : 'negative'}">
          ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlRate}%)
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
    const typeLabel = t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : '分红';
    const typeClass = t.type === 'buy' ? 'buy' : t.type === 'sell' ? 'sell' : 'dividend';
    const priceStr = t.price != null ? t.price.toFixed(4) : '-';
    return `
      <tr>
        <td>${esc(t.date)}</td>
        <td>${esc(acc?.name || '未知')}</td>
        <td>${esc(t.fundName)}</td>
        <td><span class="tx-type ${typeClass}">${typeLabel}</span></td>
        <td>${priceStr}</td>
        <td>${t.shares.toFixed(2)}</td>
        <td>${t.type === 'dividend' ? '-' : `¥${t.amount.toFixed(2)}`}</td>
        <td><button class="btn-edit" onclick="editTransaction('${t.id}')">编辑</button></td>
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
    ctx.fillText(formatCompact(val), pad.left - 8, y + 4);
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
      tooltip.innerHTML = `<div>${s.date}</div><div>市值: ¥${s.totalValue.toFixed(2)}</div><div>成本: ¥${s.totalCost.toFixed(2)}</div><div class="${pnl >= 0 ? 'positive' : 'negative'}">收益: ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlRate}%)</div>`;
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
          ${h.shares.toFixed(2)}份 · 净值${h.currentNav.toFixed(4)} ·
          <span class="${(h.shares * h.currentNav - h.shares * h.costPerShare) >= 0 ? 'positive' : 'negative'}">
            ${(h.shares * h.currentNav - h.shares * h.costPerShare) >= 0 ? '+' : ''}¥${(h.shares * h.currentNav - h.shares * h.costPerShare).toFixed(2)}
          </span>
        </span>
      </div>
    `).join('');

    return `
      <div class="history-card">
        <div class="history-header" onclick="toggleHistory(${idx})">
          <div>
            <span class="history-date">${snap.date}</span>
            <span class="history-value">¥${snap.totalValue.toFixed(2)}</span>
          </div>
          <div class="history-summary">
            <span class="${pnl >= 0 ? 'positive' : 'negative'}">${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlRate}%)</span>
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
  if (id === 'modal-holding' || id === 'modal-transaction' || id === 'modal-csv') {
    const selectMap = { 'modal-holding': 'hold-account', 'modal-transaction': 'tx-account', 'modal-csv': 'csv-account' };
    populateAccountSelect(selectMap[id]);
  }
  if (id === 'modal-holding') {
    document.getElementById('holding-upload-area').style.display = 'none';
    clearImagePreview('holding');
    document.getElementById('hold-product-type').value = '';
  }
  if (id === 'modal-transaction') {
    document.getElementById('tx-upload-area').style.display = 'none';
    clearImagePreview('tx');
    document.getElementById('tx-fund').innerHTML = '<option value="">选择持仓基金</option>';
    document.getElementById('tx-type').value = 'buy';
    document.getElementById('tx-price').value = '';
    document.getElementById('tx-amount').value = '';
    document.getElementById('tx-shares').value = '';
    document.getElementById('tx-date').value = new Date().toISOString().split('T')[0];
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

function checkTxUploadVisibility() {
  const acc = document.getElementById('tx-account').value;
  document.getElementById('tx-upload-area').style.display = acc ? 'block' : 'none';
  // Populate fund dropdown when account changes
  populateTxFundSelectDirect(acc);
}

// Populate the tx-fund dropdown directly in the transaction modal
function populateTxFundSelectDirect(accountId) {
  const select = document.getElementById('tx-fund');
  if (!select) return;
  select.innerHTML = '<option value="">选择持仓基金</option>';
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
    select.appendChild(opt);
  });
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
  } catch (err) { showError(err.message); return null; }
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
  } catch (err) { showError('识别失败: ' + err.message); }
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
    const srcAcc = document.getElementById('tx-account').value;
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
    const srcAcc = document.getElementById('tx-account').value;
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
      const fundCode = document.getElementById('ocr-code').value.trim();
      const type = document.getElementById('ocr-tx-type').value;
      const price = parseFloat(document.getElementById('ocr-price').value);
      if (isNaN(price)) return showError('请填写价格');
      const shares = parseFloat(document.getElementById('ocr-tx-shares').value);
      if (isNaN(shares)) return showError('请填写交易份额');
      const amount = price * shares;
      vaultData.transactions.push({ id: crypto.randomUUID(), accountId, fundCode, fundName, type, price, amount, shares, date });
    }
    closeModal('modal-ocr-confirm');
    saveVault().then(() => renderDashboard()).catch(err => showError('保存失败: ' + err.message));
  } catch (err) {
    showError('操作失败: ' + err.message);
  }
}

function handleAddTransaction(e) {
  e.preventDefault();
  const accountId = document.getElementById('tx-account').value;
  if (!accountId) return showError('请选择账户');
  const fundName = document.getElementById('tx-fund').value;
  if (!fundName) return showError('请选择基金');
  const selectedOption = document.getElementById('tx-fund').options[document.getElementById('tx-fund').selectedIndex];
  const fundCode = selectedOption.dataset.fundCode || '';
  const type = document.getElementById('tx-type').value;
  const price = parseFloat(document.getElementById('tx-price').value);
  if (isNaN(price)) return showError('请填写价格');
  const shares = parseFloat(document.getElementById('tx-shares').value);
  if (isNaN(shares)) return showError('请填写交易份额');
  const amount = price * shares;
  const date = document.getElementById('tx-date').value || new Date().toISOString().split('T')[0];
  vaultData.transactions.push({ id: crypto.randomUUID(), accountId, fundCode, fundName, type, price, amount, shares, date });
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
    } catch (err) { showError('CSV 解析失败: ' + err.message); }
  };
  reader.readAsText(file, 'UTF-8');
}

function handleLogout() {
  vaultData = null; currentPassword = null; vaultId = null;
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

// --- Init ---
document.getElementById('auth-form').addEventListener('submit', handleAuth);
document.getElementById('form-account').addEventListener('submit', handleAddAccount);
document.getElementById('form-rename-account').addEventListener('submit', handleRenameAccount);
document.getElementById('form-edit-holding').addEventListener('submit', handleEditHolding);
document.getElementById('form-ocr-confirm').addEventListener('submit', handleOCRConfirm);
document.getElementById('form-transaction').addEventListener('submit', handleAddTransaction);
document.getElementById('form-edit-transaction').addEventListener('submit', handleEditTransaction);
document.getElementById('form-csv').addEventListener('submit', handleCsvImport);
document.getElementById('btn-logout').addEventListener('click', handleLogout);

document.getElementById('hold-account').addEventListener('change', checkHoldingUploadVisibility);
document.getElementById('hold-product-type').addEventListener('change', checkHoldingUploadVisibility);
document.getElementById('tx-account').addEventListener('change', checkTxUploadVisibility);

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
window.addEventListener('resize', () => { if (vaultData) renderTrendChart(); });

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
