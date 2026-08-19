const text = (id, value) => {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
};

async function refresh() {
  const dot = document.querySelector('#health .dot');
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();

    dot?.setAttribute('data-state', 'ok');
    text('health-text', `connected · v${health.version}`);
    text('fact-version', health.version);
    text('fact-node', health.node);
    text('fact-dir', health.claudeDir);
    text(
      'fact-sources',
      health.sources
        .map((source) => `${source.label} ${source.available ? '✓' : '✗'}`)
        .join(' · ') || 'none',
    );
  } catch (error) {
    dot?.setAttribute('data-state', 'bad');
    text('health-text', `disconnected · ${error.message}`);
  }
}

refresh();
setInterval(refresh, 5000);
