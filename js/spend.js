/**
 * PricePulse — Spend Lens Module
 */
(function () {
  const connectGrid = document.getElementById('connect-grid');
  const spendDashboard = document.getElementById('spend-dashboard');
  const totalSpendEl = document.getElementById('total-spend');
  const monthSpendEl = document.getElementById('month-spend');
  const connectedCountEl = document.getElementById('connected-count');
  const transactionsList = document.getElementById('transactions-list');
  const chartCanvas = document.getElementById('spend-chart');

  const connected = new Set();
  let chartInstance = null;

  const platformColors = {
    amazon: '#FF9900',
    flipkart: '#2874F0',
    myntra: '#FF3F6C',
    ajio: '#D4AF37',
  };

  function formatPrice(amount) {
    return '₹' + amount.toLocaleString('en-IN');
  }

  function simulateConnect(card, platform) {
    const statusEl = card.querySelector('.connect-status');
    statusEl.textContent = 'Connecting…';
    card.style.pointerEvents = 'none';

    setTimeout(() => {
      connected.add(platform);
      card.classList.add('connected');
      statusEl.textContent = 'Connected ✓';
      card.style.pointerEvents = '';
      updateDashboard();
    }, 1200 + Math.random() * 800);
  }

  function updateDashboard() {
    if (connected.size === 0) {
      spendDashboard.classList.add('hidden');
      return;
    }

    spendDashboard.classList.remove('hidden');

    const data = PricePulseAPI.getSpendData([...connected]);

    totalSpendEl.textContent = formatPrice(data.totalSpend);
    monthSpendEl.textContent = formatPrice(data.monthSpend);
    connectedCountEl.textContent = connected.size;

    renderChart(data.chartData);
    renderTransactions(data.transactions);
  }

  function renderChart(chartData) {
    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(chartCanvas, {
      type: 'bar',
      data: {
        labels: chartData.map(d => d.month),
        datasets: [{
          label: 'Monthly Spend',
          data: chartData.map(d => d.amount),
          backgroundColor: chartData.map((_, i) =>
            `rgba(212, 175, 55, ${0.4 + i * 0.1})`
          ),
          borderColor: '#D4AF37',
          borderWidth: 1,
          borderRadius: 8,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(45, 10, 26, 0.95)',
            titleColor: '#D4AF37',
            bodyColor: '#F5F0EB',
            borderColor: 'rgba(212,175,55,0.3)',
            borderWidth: 1,
            padding: 12,
            callbacks: {
              label: (ctx) => ' ' + formatPrice(ctx.raw),
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(245,240,235,0.5)', font: { family: 'Outfit' } },
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: {
              color: 'rgba(245,240,235,0.5)',
              font: { family: 'Outfit' },
              callback: (v) => '₹' + (v / 1000) + 'k',
            },
          },
        },
      },
    });
  }

  function renderTransactions(transactions) {
    transactionsList.innerHTML = transactions.map((tx, i) => {
      const color = platformColors[tx.platformId] || '#6B1D3A';
      return `
        <div class="transaction-item" style="animation-delay:${i * 0.05}s">
          <div class="tx-icon" style="background:${color};color:${tx.platformId === 'amazon' ? '#111' : '#fff'}">
            ${tx.platform.charAt(0)}
          </div>
          <div class="tx-info">
            <h4>${tx.item}</h4>
            <p>${tx.platform} · ${tx.date}</p>
          </div>
          <span class="tx-amount">${formatPrice(tx.amount)}</span>
        </div>
      `;
    }).join('');
  }

  connectGrid.querySelectorAll('.connect-card').forEach(card => {
    card.addEventListener('click', () => {
      const platform = card.dataset.platform;
      if (connected.has(platform)) return;
      simulateConnect(card, platform);
    });
  });
})();
