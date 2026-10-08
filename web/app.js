// Relative API base: the frontend is served by the API server itself, so it
// works on whatever port/host the server runs on (no hardcoded origin).
const API_BASE = '';

// Bearer token for the API when the server was started with
// REPO_MEMORY_API_TOKEN (injected via /config.js, which the server serves
// unauthenticated so the page can authenticate its own requests).
const API_TOKEN = window.REPO_MEMORY_API_TOKEN || '';
const AUTH_HEADERS = API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};

const TYPE_COLORS = {
  Class: '#58a6ff',
  Interface: '#bc8cff',
  Function: '#3fb950',
  Method: '#3fb950',
  Constructor: '#3fb950',
  Enum: '#d29922',
  Variable: '#8b949e',
  TypeAlias: '#bc8cff',
  Property: '#8b949e',
  File: '#484f58',
  Test: '#3fb950',
  TestSuite: '#3fb950',
  ApiEndpoint: '#f778ba',
  Config: '#d29922',
};

const GROUP_COLORS = {
  app: '#f0883e',
  shared: '#8b949e',
  ingestion: '#3fb950',
  analysis: '#bc8cff',
  graph: '#58a6ff',
  storage: '#d29922',
  api: '#f778ba',
  web: '#79c0ff',
  tests: '#3fb950',
  source: '#58a6ff',
  lib: '#d2a8ff',
  cmd: '#f0883e',
  internal: '#8b949e',
  pkg: '#d29922',
  config: '#f778ba',
  docs: '#79c0ff',
  scripts: '#ffa657',
  other: '#484f58',
};

let allEntities = [];
let graphNodes = [];
let graphLinks = [];
let simulation = null;
let selectedEntityId = null;
let currentView = 'architecture';
let selectedCommitHash = null;
let currentRepo = 'all';
let activeAnalysisReport = 'churn';

// DOM refs
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const repoFilter = document.getElementById('repoFilter');
const entityListContent = document.getElementById('entityListContent');
const entityCount = document.getElementById('entityCount');
const statsEl = document.getElementById('stats');
const detailPanel = document.getElementById('detailPanel');
const detailTitle = document.getElementById('detailTitle');
const detailContent = document.getElementById('detailContent');
const closeDetail = document.getElementById('closeDetail');
const graphSvg = d3.select('#graph');
const depthSelect = document.getElementById('depthSelect');
const typeFilter = document.getElementById('typeFilter');
const entityPanel = document.getElementById('entityPanel');
const commitPanel = document.getElementById('commitPanel');
const commitListContent = document.getElementById('commitListContent');
const commitRefresh = document.getElementById('commitRefresh');
const graphLoading = document.getElementById('graphLoading');
const tooltipEl = document.getElementById('tooltip');
const analysisPanel = document.getElementById('analysisPanel');
const analysisContent = document.getElementById('analysisContent');
const jobsPanel = document.getElementById('jobsPanel');
const jobsVerifyBtn = document.getElementById('jobsVerifyBtn');
const jobsRepairBtn = document.getElementById('jobsRepairBtn');
const jobsRefreshBtn = document.getElementById('jobsRefreshBtn');
const jobsDetail = document.getElementById('jobsDetail');
const jobsListContent = document.getElementById('jobsListContent');
const qaPanel = document.getElementById('qaPanel');
const qaInput = document.getElementById('qaInput');
const qaBtn = document.getElementById('qaBtn');
const qaResult = document.getElementById('qaResult');
const qaSuggestions = document.getElementById('qaSuggestions');

// --- API ---
async function api(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: AUTH_HEADERS });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
    body: body ? JSON.stringify(body) : '{}',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API ${res.status}`);
  }
  return res.json();
}

// --- Utilities ---
function escHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortPath(p) {
  return p.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function showGraphLoading() { graphLoading.classList.remove('hidden'); }
function hideGraphLoading() { graphLoading.classList.add('hidden'); }

// --- Tooltip ---
function showTooltip(html, event) {
  tooltipEl.innerHTML = html;
  tooltipEl.style.display = 'block';
  const x = Math.min(event.pageX + 12, window.innerWidth - 320);
  const y = event.pageY - 10;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
}

function hideTooltip() {
  tooltipEl.style.display = 'none';
}

// --- Navigation ---
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    if (view === 'architecture') {
      entityPanel.classList.remove('hidden');
      commitPanel.classList.add('hidden');
      analysisPanel.classList.add('hidden');
      qaPanel.classList.add('hidden');
      currentView = 'architecture';
      loadArchitectureGraph();
    } else if (view === 'commits') {
      entityPanel.classList.add('hidden');
      commitPanel.classList.remove('hidden');
      analysisPanel.classList.add('hidden');
      qaPanel.classList.add('hidden');
      currentView = 'commits';
      loadCommits();
    } else if (view === 'analysis') {
      entityPanel.classList.add('hidden');
      commitPanel.classList.add('hidden');
      analysisPanel.classList.remove('hidden');
      jobsPanel.classList.add('hidden');
      qaPanel.classList.add('hidden');
      currentView = 'analysis';
      loadAnalysis(activeAnalysisReport);
    } else if (view === 'jobs') {
      entityPanel.classList.add('hidden');
      commitPanel.classList.add('hidden');
      analysisPanel.classList.add('hidden');
      jobsPanel.classList.remove('hidden');
      qaPanel.classList.add('hidden');
      currentView = 'jobs';
      loadJobs();
    } else if (view === 'ask') {
      entityPanel.classList.add('hidden');
      commitPanel.classList.add('hidden');
      analysisPanel.classList.add('hidden');
      jobsPanel.classList.add('hidden');
      qaPanel.classList.remove('hidden');
      currentView = 'ask';
    }
  });
});

// --- Entities ---
async function loadRepos() {
  try {
    const data = await api('/api/workspace/repos');
    const repos = data.repos || [];
    const current = repoFilter.value;
    repoFilter.innerHTML = '<option value="all">All repos</option>' +
      repos.map(r => `<option value="${escHtml(r.repoPath)}">${escHtml(r.repoPath)}</option>`).join('');
    repoFilter.value = current;
  } catch {
    repoFilter.innerHTML = '<option value="all">All repos</option>';
  }
}

repoFilter.addEventListener('change', () => {
  currentRepo = repoFilter.value;
  selectedCommitHash = null;
  loadEntities();
  if (currentView === 'architecture') {
    loadArchitectureGraph();
  } else if (currentView === 'commits') {
    loadCommits();
  } else if (currentView === 'analysis') {
    loadAnalysis(activeAnalysisReport);
  } else if (currentView === 'jobs') {
    loadJobs();
  }
});

async function loadEntities() {
  try {
    const repoParam = currentRepo !== 'all' ? `&repoPath=${encodeURIComponent(currentRepo)}` : '';
    const data = await api(`/api/workspace/entities?limit=1000${repoParam}`);
    allEntities = data.entities || [];
    entityCount.textContent = `(${allEntities.length})`;
    statsEl.textContent = `${allEntities.length} entities`;
    renderEntityList(allEntities);
  } catch (err) {
    entityListContent.innerHTML = `<div class="empty-state">Failed to load entities<br><small>${escHtml(err.message)}</small></div>`;
  }
}

function getFilteredEntities() {
  let list = allEntities;
  const typeVal = typeFilter.value;
  if (typeVal) list = list.filter(e => e.type === typeVal);
  return list;
}

function renderEntityList(entities) {
  if (!entities.length) {
    entityListContent.innerHTML = '<div class="empty-state">No entities found</div>';
    return;
  }
  entityListContent.innerHTML = entities.slice(0, 300).map(e => `
    <div class="entity-item${e.stableId === selectedEntityId ? ' selected' : ''}" data-stable-id="${escHtml(e.stableId)}">
      <div class="name">
        <span class="type-badge type-${escHtml(e.type)}">${escHtml(e.type)}</span>
        ${escHtml(e.name)}
      </div>
      <div class="meta">${e.repoPath ? `<span class="repo-tag">${escHtml(e.repoPath)}</span>` : ''}${escHtml(shortPath(e.filePath))}</div>
    </div>
  `).join('');

  entityListContent.querySelectorAll('.entity-item').forEach(el => {
    el.addEventListener('click', () => selectEntity(el.dataset.stableId));
  });
}

typeFilter.addEventListener('change', () => {
  renderEntityList(getFilteredEntities());
});

searchBtn.addEventListener('click', async () => {
  const q = searchInput.value.trim();
  if (!q) { renderEntityList(getFilteredEntities()); return; }
  try {
    const repoParam = currentRepo !== 'all' ? `?repoPath=${encodeURIComponent(currentRepo)}` : '';
    const data = await api(`/api/workspace/entities/search/${encodeURIComponent(q)}${repoParam}`);
    renderEntityList(data.entities || []);
  } catch { renderEntityList([]); }
});

searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });

// --- Entity selection & detail ---
async function selectEntity(stableId) {
  let entity = allEntities.find(e => e.stableId === stableId);
  if (!entity) {
    try {
      const data = await api(`/api/workspace/entities/${stableId}`);
      entity = data.entity;
    } catch { /* not found */ }
  }
  if (!entity) return;
  await openEntityDetail(entity);
}

async function openEntityDetail(entity) {
  selectedEntityId = entity.stableId;
  if (!allEntities.find(e => e.stableId === entity.stableId)) {
    allEntities.unshift(entity);
    renderEntityList(getFilteredEntities());
  }

  entityListContent.querySelectorAll('.entity-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.stableId === entity.stableId);
  });

  detailPanel.classList.remove('hidden');
  renderDetail(entity);

  const depth = parseInt(depthSelect.value);
  showGraphLoading();
  await Promise.all([
    loadGraph(entity.stableId, depth),
    loadImpactAnalysis(entity.stableId),
    loadSimilarEntities(entity.stableId),
    loadContextPack(entity.stableId),
    loadChangeAnalysis(entity.stableId),
    loadMembers(entity.stableId),
    loadSource(entity.stableId),
  ]);
  hideGraphLoading();
}

function renderDetail(entity) {
  detailTitle.textContent = entity.name;

  let html = '';

  // Core info
  html += `<div class="detail-section">
    <h3>Info</h3>
    <div class="detail-row"><div class="label">Type</div><div class="value"><span class="type-badge type-${escHtml(entity.type)}">${escHtml(entity.type)}</span></div></div>
    <div class="detail-row"><div class="label">Language</div><div class="value">${escHtml(entity.language)}</div></div>
    <div class="detail-row"><div class="label">File</div><div class="value path">${escHtml(entity.filePath)}</div></div>
    <div class="detail-row"><div class="label">Lines</div><div class="value">${entity.startLine}&ndash;${entity.endLine}</div></div>
    <div class="detail-row"><div class="label">Exported</div><div class="value">${entity.isExported ? 'Yes' : 'No'}</div></div>
    <div class="detail-row"><div class="label">Confidence</div><div class="value">${(entity.confidence * 100).toFixed(0)}%</div></div>
    ${entity.purpose ? `<div class="detail-row"><div class="label">Purpose</div><div class="value">${escHtml(entity.purpose)}</div></div>` : ''}
    ${entity.responsibility ? `<div class="detail-row"><div class="label">Responsibility</div><div class="value">${escHtml(entity.responsibility)}</div></div>` : ''}
    ${entity.signature ? `<div class="detail-row"><div class="label">Signature</div><div class="value mono">${escHtml(entity.signature)}</div></div>` : ''}
  </div>`;

  // Stable ID
  html += `<div class="detail-section">
    <h3>Identity</h3>
    <div class="detail-row"><div class="value mono">${escHtml(entity.stableId)}</div></div>
  </div>`;

  // Documentation (JSDoc/docstring, placeholder-free)
  if (entity.docstring) {
    html += `<div class="detail-section">
      <h3>Documentation</h3>
      <div class="doc-block">${escHtml(entity.docstring)}</div>
    </div>`;
  }

  // Source code (placeholder, filled async)
  html += `<div class="detail-section" id="sourceSection">
    <h3>Source</h3>
    <div class="loading-text">Loading...</div>
  </div>`;

  // Members (placeholder, filled async)
  html += `<div class="detail-section" id="membersSection">
    <h3>Members</h3>
    <div class="loading-text">Loading...</div>
  </div>`;

  // Similar entities (placeholder, filled async)
  html += `<div class="detail-section" id="similarSection">
    <h3>Similar Entities</h3>
    <div class="loading-text">Loading...</div>
  </div>`;

  // Impact analysis (placeholder)
  html += `<div class="detail-section" id="impactSection">
    <h3>Impact Analysis</h3>
    <div class="loading-text">Loading...</div>
  </div>`;

  // Context pack (placeholder)
  html += `<div class="detail-section" id="contextPackSection">
    <h3>Context Pack</h3>
    <div class="loading-text">Loading...</div>
  </div>`;

  // Change analysis (placeholder)
  html += `<div class="detail-section" id="changeSection">
    <h3>Change Analysis</h3>
    <div class="loading-text">Loading...</div>
  </div>`;

  detailContent.innerHTML = html;
}

closeDetail.addEventListener('click', () => {
  detailPanel.classList.add('hidden');
  selectedEntityId = null;
  entityListContent.querySelectorAll('.entity-item').forEach(el => el.classList.remove('selected'));
  if (currentView === 'architecture') loadArchitectureGraph();
});

// --- Graph ---
function requireD3() {
  if (typeof d3 === 'undefined') {
    graphLoading.classList.remove('hidden');
    graphLoading.querySelector('span').textContent =
      'Graph library (D3) failed to load — check network or vendor d3.min.js locally.';
    return false;
  }
  return true;
}

async function loadGraph(stableId, depth) {
  try {
    const data = await api(`/api/graph/traverse/${stableId}?depth=${depth}`);
    buildGraph(data);
  } catch (err) {
    console.error('Graph load failed:', err);
    buildGraph({ entity: allEntities.find(e => e.stableId === stableId), dependencies: [], dependents: [] });
  }
}

function buildGraph(data) {
  if (!requireD3()) return;
  const nodes = new Map();
  const links = [];

  if (data.entity) {
    nodes.set(data.entity.stableId, { ...data.entity, group: 'center' });
  }

  (data.dependencies || []).forEach(e => {
    if (!nodes.has(e.stableId)) nodes.set(e.stableId, { ...e, group: 'dependency' });
    if (data.entity) links.push({ source: data.entity.stableId, target: e.stableId, type: 'depends' });
  });

  (data.dependents || []).forEach(e => {
    if (!nodes.has(e.stableId)) nodes.set(e.stableId, { ...e, group: 'dependent' });
    if (data.entity) links.push({ source: e.stableId, target: data.entity.stableId, type: 'depends' });
  });

  graphNodes = Array.from(nodes.values());
  graphLinks = links;
  renderGraph();
}

function renderGraph() {
  if (!requireD3()) return;
  const container = document.getElementById('graphContainer');
  const width = container.clientWidth;
  const height = container.clientHeight;

  graphSvg.selectAll('*').remove();

  if (!graphNodes.length) {
    graphSvg.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#484f58')
      .attr('font-size', '13px')
      .text('Select an entity to view its graph');
    return;
  }

  const g = graphSvg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => g.attr('transform', e.transform));
  graphSvg.call(zoom);

  document.getElementById('zoomIn').onclick = () => graphSvg.transition().call(zoom.scaleBy, 1.3);
  document.getElementById('zoomOut').onclick = () => graphSvg.transition().call(zoom.scaleBy, 0.7);
  document.getElementById('zoomReset').onclick = () => graphSvg.transition().call(zoom.transform, d3.zoomIdentity);

  const defs = graphSvg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow').attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#c9d1d9');

  simulation = d3.forceSimulation(graphNodes)
    .force('link', d3.forceLink(graphLinks).id(d => d.stableId).distance(90))
    .force('charge', d3.forceManyBody().strength(-250))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(25));

  const link = g.append('g').selectAll('line').data(graphLinks).join('line')
    .attr('class', 'link').attr('marker-end', 'url(#arrow)');

  const node = g.append('g').selectAll('g').data(graphNodes).join('g')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append('circle')
    .attr('r', d => d.group === 'center' ? 10 : 7)
    .attr('fill', d => d.group === 'center' ? '#f0f6fc' : (TYPE_COLORS[d.type] || '#484f58'))
    .attr('stroke', d => d.group === 'center' ? '#58a6ff' : 'none')
    .attr('stroke-width', d => d.group === 'center' ? 2.5 : 0)
    .style('cursor', 'pointer')
    .on('click', (e, d) => selectEntity(d.stableId))
    .on('mouseover', (e, d) => {
      showTooltip(`<strong>${escHtml(d.name)}</strong><br><span style="color:${TYPE_COLORS[d.type] || '#8b949e'}">${escHtml(d.type)}</span><br><span style="color:#8b949e">${escHtml(shortPath(d.filePath))}</span>`, e);
    })
    .on('mouseout', hideTooltip);

  node.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => (d.group === 'center' ? 10 : 7) + 13)
    .text(d => d.name.length > 18 ? d.name.slice(0, 16) + '..' : d.name);

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

// --- Architecture graph ---
async function loadArchitectureGraph() {
  showGraphLoading();
  try {
    const repoParam = currentRepo !== 'all' ? `?repoPath=${encodeURIComponent(currentRepo)}` : '';
    const data = await api(`/api/graph/architecture${repoParam}`);
    currentView = 'architecture';
    selectedEntityId = null;
    detailPanel.classList.add('hidden');

    graphNodes = (data.files || []).map(f => ({ ...f, type: 'File' }));
    graphLinks = data.links || [];
    
    // Update stats
    if (statsEl) {
      statsEl.textContent = `${graphNodes.length} files, ${graphLinks.length} dependencies`;
    }
    
    renderArchitectureGraph();
  } catch (err) {
    console.error('Architecture load failed:', err);
    graphNodes = [];
    graphLinks = [];
    renderArchitectureGraph();
  }
  hideGraphLoading();
}

function renderArchitectureGraph() {
  if (!requireD3()) return;
  const container = document.getElementById('graphContainer');
  const width = container.clientWidth;
  const height = container.clientHeight;

  graphSvg.selectAll('*').remove();

  if (!graphNodes.length) {
    graphSvg.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle').attr('fill', '#484f58').attr('font-size', '13px')
      .text('No architecture data');
    return;
  }

  const g = graphSvg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', e => g.attr('transform', e.transform));
  graphSvg.call(zoom);

  document.getElementById('zoomIn').onclick = () => graphSvg.transition().call(zoom.scaleBy, 1.3);
  document.getElementById('zoomOut').onclick = () => graphSvg.transition().call(zoom.scaleBy, 0.7);
  document.getElementById('zoomReset').onclick = () => graphSvg.transition().call(zoom.transform, d3.zoomIdentity);

  const defs = graphSvg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow-arch').attr('viewBox', '0 -5 10 10')
    .attr('refX', 18).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#c9d1d9');

  simulation = d3.forceSimulation(graphNodes)
    .force('link', d3.forceLink(graphLinks).id(d => d.id).distance(140))
    .force('charge', d3.forceManyBody().strength(-400))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => Math.min(32, Math.max(12, d.entityCount * 1.8))));

  const link = g.append('g').selectAll('line').data(graphLinks).join('line')
    .attr('class', 'link').attr('marker-end', 'url(#arrow-arch)');

  const node = g.append('g').selectAll('g').data(graphNodes).join('g')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  node.append('circle')
    .attr('r', d => Math.max(7, Math.min(22, d.entityCount * 1.8)))
    .attr('fill', d => GROUP_COLORS[d.group] || '#484f58')
    .attr('stroke', '#0d1117').attr('stroke-width', 1.5)
    .style('cursor', 'pointer')
    .on('click', (e, d) => selectFile(d.fullPath))
    .on('mouseover', (e, d) => {
      showTooltip(`<strong>${escHtml(d.name)}</strong><br><span style="color:${GROUP_COLORS[d.group] || '#8b949e'}">${escHtml(d.group)}</span><br><span style="color:#8b949e">${d.entityCount} entities</span><br><span style="color:#8b949e;font-size:10px">${escHtml((d.entityTypes || []).slice(0, 4).join(', '))}</span>`, e);
    })
    .on('mouseout', hideTooltip);

  node.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => Math.max(7, Math.min(22, d.entityCount * 1.8)) + 13)
    .text(d => d.name.length > 22 ? d.name.slice(0, 20) + '..' : d.name);

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

async function selectFile(filePath) {
  currentView = 'entity';
  const fileEntities = allEntities.filter(e => e.filePath === filePath);
  if (fileEntities.length > 0) await selectEntity(fileEntities[0].stableId);
}

depthSelect.addEventListener('change', () => {
  if (selectedEntityId) loadGraph(selectedEntityId, parseInt(depthSelect.value));
});

// --- Commits ---
async function loadCommits() {
  commitListContent.innerHTML = '<div class="loading-text">Loading commits...</div>';
  try {
    const repoParam = currentRepo !== 'all' ? `&repoPath=${encodeURIComponent(currentRepo)}` : '';
    const data = await api(`/api/commits?limit=50${repoParam}`);
    renderCommitList(data.commits || []);
  } catch (err) {
    commitListContent.innerHTML = `<div class="empty-state">No commits found<br><small>${escHtml(err.message)}</small></div>`;
  }
}

function renderCommitList(commits) {
  if (!commits.length) {
    commitListContent.innerHTML = '<div class="empty-state">No commits yet</div>';
    return;
  }
  commitListContent.innerHTML = commits.map(c => `
    <div class="commit-item${c.hash === selectedCommitHash ? ' selected' : ''}" data-hash="${escHtml(c.hash)}">
      <div class="hash">${c.hash.slice(0, 8)}</div>
      <div class="msg">${escHtml(c.message)}</div>
      <div class="meta">
        ${c.repoPath && currentRepo === 'all' ? `<span class="repo-tag">${escHtml(c.repoPath)}</span>` : ''}
        <span>${escHtml(c.author)}</span>
        <span>${timeAgo(c.date)}</span>
      </div>
    </div>
  `).join('');

  commitListContent.querySelectorAll('.commit-item').forEach(el => {
    el.addEventListener('click', () => showCommitDetail(el.dataset.hash));
  });
}

async function showCommitDetail(hash) {
  selectedCommitHash = hash;
  commitListContent.querySelectorAll('.commit-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.hash === hash);
  });

  // Expand file changes inline
  const existing = commitListContent.querySelector('.commit-files');
  if (existing) existing.remove();

  const itemEl = commitListContent.querySelector(`.commit-item[data-hash="${hash}"]`);
  if (!itemEl) return;

  try {
    const data = await api(`/api/commits/${hash}`);
    const changes = data.fileChanges || [];
    if (changes.length) {
      const div = document.createElement('div');
      div.className = 'commit-files';
      div.innerHTML = changes.slice(0, 20).map(fc => `
        <div class="file-change">
          <span class="status ${fc.status}">${fc.status}</span>
          <span class="path">${escHtml(shortPath(fc.filePath))}</span>
        </div>
      `).join('');
      itemEl.after(div);
    }
  } catch (err) {
    console.error('Commit detail failed:', err);
  }
}

commitRefresh.addEventListener('click', loadCommits);

// --- Impact Analysis ---
async function loadImpactAnalysis(stableId) {
  const section = document.getElementById('impactSection');
  if (!section) return;
  try {
    const data = await api(`/api/analysis/impact/${stableId}`);
    const risk = data.riskScore || 0;
    const riskPct = Math.round(risk * 100);
    const riskClass = risk < 0.3 ? 'low' : risk < 0.7 ? 'med' : 'high';
    const directCount = (data.directImpact || []).length;
    const indirectCount = (data.indirectImpact || []).length;
    const fileCount = (data.affectedFiles || []).length;

    section.innerHTML = `
      <h3>Impact Analysis</h3>
      <div class="detail-row">
        <div class="label">Risk Score</div>
        <div class="risk-score risk-${riskClass}">${riskPct}%</div>
        <div class="impact-bar impact-${riskClass}"><div class="fill" style="width:${riskPct}%"></div></div>
      </div>
      <div class="detail-row"><div class="label">Direct Dependents</div><div class="value">${directCount}</div></div>
      <div class="detail-row"><div class="label">Indirect Dependents</div><div class="value">${indirectCount}</div></div>
      <div class="detail-row"><div class="label">Affected Files</div><div class="value">${fileCount}</div></div>
      ${data.affectedFiles && data.affectedFiles.length ? `
        <div class="detail-row">
          <div class="label">Files at Risk</div>
          <ul class="dep-list">
            ${data.affectedFiles.slice(0, 8).map(f => `<li>${escHtml(shortPath(f))}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    `;
  } catch {
    section.innerHTML = '<h3>Impact Analysis</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Members ---
async function loadMembers(stableId) {
  const section = document.getElementById('membersSection');
  if (!section) return;
  try {
    const data = await api(`/api/entities/${stableId}/members?limit=100`);
    const members = data.members || [];
    const total = data.total ?? members.length;
    if (!members.length) {
      section.innerHTML = '<h3>Members</h3><div class="empty-state">No members</div>';
      return;
    }
    section.innerHTML = `
      <h3>Members <span style="font-weight:400;text-transform:none;color:#8b949e">${members.length}${total > members.length ? ` of ${total}` : ''}</span></h3>
      <div class="dep-list">
        ${members.map(m => `
          <li class="similar-item" data-stable-id="${escHtml(m.stableId)}">
            <span class="type-badge type-${escHtml(m.type)}">${escHtml(m.type)}</span>
            <span>${escHtml(m.name)}</span>
          </li>
        `).join('')}
      </div>
    `;
    section.querySelectorAll('.similar-item').forEach(el => {
      el.addEventListener('click', () => selectEntity(el.dataset.stableId));
    });
  } catch {
    section.innerHTML = '<h3>Members</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Source ---
async function loadSource(stableId) {
  const section = document.getElementById('sourceSection');
  if (!section) return;
  try {
    const data = await api(`/api/entities/${stableId}/source?maxLines=200`);
    section.innerHTML = `
      <h3>Source <span style="font-weight:400;text-transform:none;color:#8b949e">lines ${data.startLine}&ndash;${data.endLine} of ${data.totalLines}${data.truncated ? ' (truncated)' : ''}</span></h3>
      <pre class="code-block">${escHtml(data.source)}</pre>
    `;
  } catch {
    section.innerHTML = '<h3>Source</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Similar Entities ---
async function loadSimilarEntities(stableId) {
  const section = document.getElementById('similarSection');
  if (!section) return;
  try {
    const data = await api(`/api/entities/similar/${stableId}?limit=6`);
    const similar = data.similar || [];
    if (!similar.length) {
      section.innerHTML = '<h3>Similar Entities</h3><div class="empty-state">None found</div>';
      return;
    }
    section.innerHTML = `
      <h3>Similar Entities</h3>
      <div class="dep-list">
        ${similar.map(s => `
          <li class="similar-item" data-stable-id="${escHtml(s.stableId)}">
            <span class="type-badge type-${escHtml(s.type)}">${escHtml(s.type)}</span>
            <span>${escHtml(s.name)}</span>
          </li>
        `).join('')}
      </div>
    `;
    section.querySelectorAll('.similar-item').forEach(el => {
      el.addEventListener('click', () => selectEntity(el.dataset.stableId));
    });
  } catch {
    section.innerHTML = '<h3>Similar Entities</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Context Pack ---
async function loadContextPack(stableId) {
  const section = document.getElementById('contextPackSection');
  if (!section) return;
  try {
    const data = await api(`/api/context-pack/${stableId}?tokenBudget=4000`);
    const tokens = data.tokenCount || 0;
    const deps = data.dependencies || [];
    const dependents = data.dependents || [];
    const similar = data.similarEntities || [];
    const recent = data.recentChanges || [];
    const metadata = data.metadata || {};
    const lines = [];

    lines.push(`${data.entity.name} (${data.entity.type})`);
    lines.push(`File: ${data.entity.filePath}`);
    if (metadata.packageName) lines.push(`Package: ${metadata.packageName}`);
    if (data.entity.purpose) lines.push(`Purpose: ${data.entity.purpose}`);
    lines.push('');
    if (deps.length) {
      lines.push('Dependencies:');
      deps.forEach(d => lines.push(`  ${d.name} (${d.type}) ${d.filePath}`));
    }
    if (dependents.length) {
      lines.push('Dependents:');
      dependents.forEach(d => lines.push(`  ${d.name} (${d.type}) ${d.filePath}`));
    }
    if (recent.length) {
      lines.push('Recent changes:');
      recent.forEach(r => lines.push(`  ${r.hash.slice(0, 8)} ${r.message}`));
    }
    if (similar.length) {
      lines.push('Similar entities:');
      similar.forEach(s => lines.push(`  ${s.name} (${s.type})`));
    }

    section.innerHTML = `
      <h3>Context Pack <span style="font-weight:400;text-transform:none;color:#8b949e">${tokens} tokens</span></h3>
      <div class="context-pack">${escHtml(lines.join('\n').slice(0, 3000))}</div>
    `;
  } catch {
    section.innerHTML = '<h3>Context Pack</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Change Analysis (entity-level) ---
async function loadChangeAnalysis(stableId) {
  const section = document.getElementById('changeSection');
  if (!section) return;
  try {
    const data = await api(`/api/analysis/risk/${stableId}`);
    const info = data.entity;
    if (!info) throw new Error('empty');

    let html = `<h3>Change Analysis</h3>`;
    html += `<div class="detail-row"><div class="label">Commits Touching It</div><div class="value">${info.commitCount}</div></div>`;
    html += `<div class="detail-row"><div class="label">First Seen</div><div class="value mono">${info.firstSeenCommit ? info.firstSeenCommit.slice(0, 8) : 'n/a'}</div></div>`;
    html += `<div class="detail-row"><div class="label">Last Seen</div><div class="value mono">${info.lastSeenCommit ? info.lastSeenCommit.slice(0, 8) : 'n/a'}</div></div>`;
    if (info.stalenessDays != null) {
      html += `<div class="detail-row"><div class="label">Staleness</div><div class="value">${info.stalenessDays} day(s) since last change</div></div>`;
    }
    if (info.owningFileChurn) {
      const churn = info.owningFileChurn;
      const score = churn.churnScore || 0;
      const riskClass = score < 200 ? 'low' : score < 800 ? 'med' : 'high';
      html += `<div class="detail-row"><div class="label">Owning File Churn</div>
        <div class="value">${escHtml(shortPath(churn.filePath))} &mdash; ${churn.commits} commit(s), +${churn.additions}/-${churn.deletions}</div>
        <div class="churn-bar churn-${riskClass}"><div class="fill" style="width:${Math.min(100, score / 10)}%"></div></div>
      </div>`;
    }
    section.innerHTML = html;
  } catch {
    section.innerHTML = '<h3>Change Analysis</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Analysis tab ---
document.querySelectorAll('.analysis-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.analysis-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadAnalysis(btn.dataset.report);
  });
});

async function loadAnalysis(report) {
  activeAnalysisReport = report;
  analysisContent.innerHTML = '<div class="loading-text">Loading...</div>';
  try {
    if (report === 'churn') {
      const data = await api('/api/analysis/churn?limit=100');
      renderChurn(data.churn || []);
    } else if (report === 'risk') {
      const data = await api('/api/analysis/risk');
      renderRisk(data.risk || []);
    } else if (report === 'drift') {
      const data = await api('/api/analysis/drift');
      renderDrift(data.signals || []);
    } else if (report === 'dead-code') {
      const data = await api('/api/analysis/dead-code?includeExported=true');
      renderDeadCode(data);
    } else if (report === 'ownership') {
      const data = await api('/api/analysis/ownership?limit=500');
      renderOwnership(data.ownership || []);
    } else if (report === 'boundaries') {
      const data = await api('/api/analysis/boundaries');
      renderBoundaries(data);
    }
  } catch (err) {
    analysisContent.innerHTML = `<div class="empty-state">Failed to load<br><small>${escHtml(err.message)}</small></div>`;
  }
}

function renderChurn(churn) {
  if (!churn.length) {
    analysisContent.innerHTML = '<div class="empty-state">No churn data</div>';
    return;
  }
  analysisContent.innerHTML = churn.map(c => `
    <div class="report-item">
      <div class="report-main">${escHtml(shortPath(c.filePath))}</div>
      <div class="report-sub">${c.commits} commit(s) &middot; <span class="add">+${c.additions}</span>/<span class="del">-${c.deletions}</span> &middot; ${c.daysSinceLastChange}d ago</div>
      <div class="report-score score-${c.churnScore < 200 ? 'low' : c.churnScore < 800 ? 'med' : 'high'}">churn ${c.churnScore}</div>
    </div>
  `).join('');
}

function renderRisk(risk) {
  if (!risk.length) {
    analysisContent.innerHTML = '<div class="empty-state">No risk data</div>';
    return;
  }
  analysisContent.innerHTML = risk.slice(0, 50).map(r => {
    const cls = r.score < 30 ? 'low' : r.score < 60 ? 'med' : 'high';
    const b = r.breakdown || {};
    return `
      <div class="report-item">
        <div class="report-main">${escHtml(shortPath(r.filePath))}</div>
        <div class="risk-bar risk-${cls}"><div class="fill" style="width:${r.score}%"></div></div>
        <div class="report-sub">
          ${['churn', 'fanout', 'boundary', 'deadCode', 'staleness'].map(k => `<span class="risk-chip chip-${(b[k] || 0) < 30 ? 'low' : (b[k] || 0) < 60 ? 'med' : 'high'}">${k} ${b[k] || 0}</span>`).join('')}
        </div>
        ${r.reasons && r.reasons.length ? `<div class="report-sub reasons">${r.reasons.map(x => escHtml(x)).join(' &middot; ')}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderDrift(signals) {
  if (!signals.length) {
    analysisContent.innerHTML = '<div class="empty-state">No drift signals detected</div>';
    return;
  }
  analysisContent.innerHTML = signals.map(s => `
    <div class="report-item">
      <div class="report-main">
        <span class="severity sev-${s.severity}">${s.severity}</span>
        ${escHtml(s.type.replace(/-/g, ' '))}
      </div>
      <div class="report-sub">${escHtml(s.description)}</div>
      ${s.evidence && s.evidence.length ? `
        <div class="report-sub evidence">${s.evidence.slice(0, 5).map(e => `<div>&bull; ${escHtml(e)}</div>`).join('')}</div>
      ` : ''}
    </div>
  `).join('');
}

function renderDeadCode(data) {
  const dead = data.deadCode || [];
  const exported = data.exportedButUnused || [];
  const total = data.totalEntities || 0;
  let html = `<div class="report-summary">${dead.length} dead of ${total} entities${exported.length ? ` &middot; ${exported.length} exported but unused` : ''}</div>`;
  const items = [...dead, ...exported];
  if (!items.length) {
    analysisContent.innerHTML = html + '<div class="empty-state">No dead code</div>';
    return;
  }
  html += items.slice(0, 100).map(d => `
    <div class="report-item">
      <div class="report-main"><span class="type-badge type-${escHtml(d.entity.type)}">${escHtml(d.entity.type)}</span> ${escHtml(d.entity.name)}</div>
      <div class="report-sub">${d.entity.repoPath ? `<span class="repo-tag">${escHtml(d.entity.repoPath)}</span>` : ''}${escHtml(shortPath(d.entity.filePath))}</div>
      <div class="report-sub dead-reason">${escHtml(d.reason)}</div>
    </div>
  `).join('');
  analysisContent.innerHTML = html;
}

function renderOwnership(ownership) {
  if (!ownership.length) {
    analysisContent.innerHTML = '<div class="empty-state">No ownership data</div>';
    return;
  }
  analysisContent.innerHTML = ownership.map(o => `
    <div class="report-item">
      <div class="report-main">${escHtml(shortPath(o.filePath))}</div>
      <div class="report-sub"><span class="owner-badge">${escHtml(o.owner || 'unknown')}</span> &middot; ${o.commits} commit(s)</div>
    </div>
  `).join('');
}

function renderBoundaries(data) {
  const domains = data.domains || [];
  const violations = data.violations || [];
  const edges = data.crossDomainEdges || [];
  let html = `<div class="report-summary">${domains.length} domain(s) &middot; ${edges.length} cross-domain edge(s) &middot; ${violations.length} violation(s)${data.strict ? ' (strict)' : ''}</div>`;
  if (domains.length) {
    html += '<div class="domain-grid">' + domains.map(d =>
      `<div class="domain-chip"><strong>${escHtml(d.name)}</strong> <span>${d.fileCount}f / ${d.entityCount}e</span></div>`
    ).join('') + '</div>';
  }
  if (violations.length) {
    html += violations.slice(0, 50).map(v => `
      <div class="report-item">
        <div class="report-main">${escHtml(shortPath(v.source.filePath))} <span class="rel-type">${v.relationshipType}</span> ${escHtml(shortPath(v.target.filePath))}</div>
        <div class="report-sub">${escHtml(v.source.domain)} &rarr; ${escHtml(v.target.domain)}</div>
      </div>
    `).join('');
  } else if (domains.length) {
    html += '<div class="empty-state">No boundary violations</div>';
  }
  analysisContent.innerHTML = html;
}

// --- Reconciliation jobs tab (5.4) ---
async function loadJobs() {
  jobsListContent.innerHTML = '<div class="loading-text">Loading...</div>';
  try {
    const data = await api('/api/jobs?limit=50');
    renderJobs(data.jobs || []);
  } catch (err) {
    jobsListContent.innerHTML = `<div class="empty-state">Failed to load<br><small>${escHtml(err.message)}</small></div>`;
  }
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobsListContent.innerHTML = '<div class="empty-state">No jobs yet &mdash; run Verify or Repair</div>';
    return;
  }
  jobsListContent.innerHTML = jobs.map(j => {
    const statusCls = j.status === 'completed' ? 'low' : j.status === 'failed' ? 'high' : 'med';
    return `
      <div class="report-item job-item" data-job-id="${escHtml(j.id)}">
        <div class="report-main"><span class="job-status status-${statusCls}">${escHtml(j.status)}</span> <strong>${escHtml(j.type)}</strong></div>
        <div class="report-sub">${escHtml(j.repositoryPath)}</div>
        <div class="report-sub">${escHtml(shortPath(j.repositoryPath))} &middot; ${j.completedAt ? timeAgo(j.completedAt) : 'in progress'}</div>
      </div>
    `;
  }).join('');
  jobsListContent.querySelectorAll('.job-item').forEach(item => {
    item.addEventListener('click', () => loadJobDetail(item.dataset.jobId));
  });
}

async function loadJobDetail(jobId) {
  jobsDetail.innerHTML = '<div class="loading-text">Loading...</div>';
  try {
    const job = await api(`/api/jobs/${jobId}`);
    renderJobDetail(job);
  } catch (err) {
    jobsDetail.innerHTML = `<div class="empty-state">Failed to load job<br><small>${escHtml(err.message)}</small></div>`;
  }
}

function renderJobDetail(job) {
  if (!job.result) {
    jobsDetail.innerHTML = `<div class="report-summary">${escHtml(job.type)} &middot; ${escHtml(job.status)}${job.error ? ` &middot; <span class="del">${escHtml(job.error)}</span>` : ''}</div>`;
    return;
  }
  const r = job.result;
  if (job.type === 'verify') {
    jobsDetail.innerHTML = `
      <div class="report-summary">${r.ok ? '<span class="add">OK</span>' : '<span class="del">Issues detected</span>'} &middot; entities ${r.entityTotal} &middot; relationships ${r.relationshipTotal}</div>
      <div class="report-sub evidence">
        <div>&bull; duplicate stable IDs: ${r.duplicateStableIds}</div>
        <div>&bull; dangling sources: ${r.danglingSourceCount} / unresolved targets (info): ${r.unresolvedTargets}</div>
        <div>&bull; stale files (entities for files missing on disk): ${r.staleFileCount}${r.staleFiles && r.staleFiles.length ? ` — ${r.staleFiles.slice(0, 10).map(escHtml).join(', ')}${r.staleFileCount > r.staleFiles.length ? ', …' : ''}` : ''}</div>
        <div>&bull; entities without embedding: ${r.entitiesWithoutEmbedding}</div>
      </div>
    `;
  } else if (job.type === 'repair') {
    const va = r.verifyAfter || {};
    jobsDetail.innerHTML = `
      <div class="report-summary"><span class="add">Repaired</span> &middot; stale files removed ${r.staleFilesRemoved} &middot; embeddings generated ${r.embeddingsGenerated}</div>
      <div class="report-sub evidence">
        <div>&bull; post-repair: entities ${va.entityTotal !== undefined ? va.entityTotal : 'n/a'} &middot; relationships ${va.relationshipTotal !== undefined ? va.relationshipTotal : 'n/a'}</div>
        <div>&bull; remaining dangling sources: ${va.danglingSourceCount !== undefined ? va.danglingSourceCount : 'n/a'}</div>
        <div>&bull; remaining entities without embedding: ${va.entitiesWithoutEmbedding !== undefined ? va.entitiesWithoutEmbedding : 'n/a'}</div>
      </div>
    `;
  } else {
    jobsDetail.innerHTML = `<div class="report-summary">${escHtml(job.type)} &middot; ${escHtml(job.status)}</div>`;
  }
}

async function runJob(type) {
  const endpoint = type === 'verify' ? '/api/jobs/verify' : '/api/jobs/repair';
  const repoParam = currentRepo !== 'all' ? { repoPath: currentRepo } : undefined;
  jobsDetail.innerHTML = '<div class="loading-text">Running... (this may take a while for large repos)</div>';
  try {
    const job = await apiPost(endpoint, repoParam);
    renderJobDetail(job);
    loadJobs();
  } catch (err) {
    jobsDetail.innerHTML = `<div class="empty-state">Failed to run ${type}<br><small>${escHtml(err.message)}</small></div>`;
  }
}

jobsVerifyBtn.addEventListener('click', () => runJob('verify'));
jobsRepairBtn.addEventListener('click', () => runJob('repair'));
jobsRefreshBtn.addEventListener('click', () => {
  jobsDetail.innerHTML = '';
  loadJobs();
});

// --- QA tab ---
const QA_SUGGESTIONS = [
  'who calls createUser',
  'where is TraversalService defined',
  'which files change the most',
  'is the architecture drifting',
  'what tests cover this',
  'who owns src',
  'what changed recently',
];

qaSuggestions.innerHTML = QA_SUGGESTIONS.map(s => `<button class="qa-chip" data-q="${escHtml(s)}">${escHtml(s)}</button>`).join('');
qaSuggestions.querySelectorAll('.qa-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    qaInput.value = chip.dataset.q;
    askQuestion();
  });
});

qaBtn.addEventListener('click', askQuestion);
qaInput.addEventListener('keydown', e => { if (e.key === 'Enter') askQuestion(); });

async function askQuestion() {
  const q = qaInput.value.trim();
  if (!q) return;
  qaResult.innerHTML = '<div class="loading-text">Asking...</div>';
  const body = { question: q };
  if (currentRepo !== 'all') body.repoPath = currentRepo;
  try {
    const res = await fetch(`${API_BASE}/api/workspace/qa/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const ans = await res.json();
    renderQaAnswer(ans);
  } catch (err) {
    qaResult.innerHTML = `<div class="empty-state">Failed: ${escHtml(err.message)}</div>`;
  }
}

function renderQaAnswer(ans) {
  let html = `<div class="qa-intent">intent: ${escHtml(ans.intent || 'info')}${currentRepo !== 'all' ? ` &middot; repo: ${escHtml(currentRepo)}` : ''}</div>`;
  if (ans.entity) {
    html += `<div class="qa-entity" data-stable-id="${escHtml(ans.entity.stableId)}">
      <span class="type-badge type-${escHtml(ans.entity.type)}">${escHtml(ans.entity.type)}</span>
      <span>${escHtml(ans.entity.name)}</span>
      ${ans.entity.repoPath ? `<span class="repo-tag">${escHtml(ans.entity.repoPath)}</span>` : ''}
    </div>`;
  }
  html += `<div class="qa-answer">${escHtml(ans.answer)}</div>`;
  if (ans.evidence && ans.evidence.length) {
    html += `<div class="qa-evidence">
      ${ans.evidence.map(e => `<div class="qa-evidence-item"><span class="qa-ev-type">${escHtml(e.type)}</span>${escHtml(e.description)}</div>`).join('')}
    </div>`;
  }
  qaResult.innerHTML = html;
  const entEl = qaResult.querySelector('.qa-entity');
  if (entEl) entEl.addEventListener('click', () => selectEntity(entEl.dataset.stableId));
}

// --- Live watch indicator (5.6) ---
const liveIndicator = document.getElementById('liveIndicator');
const liveLabel = document.getElementById('liveLabel');

function renderLiveStatus(status) {
  if (!liveIndicator) return;
  if (status && status.watching) {
    liveIndicator.classList.remove('hidden', 'not-watching');
    const pending = status.pendingChanges > 0 ? ` · ${status.pendingChanges} pending` : '';
    liveLabel.textContent = status.lastScanAt
      ? `Live · synced ${timeAgo(status.lastScanAt)}${pending}`
      : `Live${pending}`;
    liveIndicator.title = `${status.repoPath}\nLast scan: ${status.lastScanAt || 'n/a'}\nPending: ${status.pendingChanges}`;
  } else {
    liveIndicator.classList.add('hidden', 'not-watching');
  }
}

async function pollLiveStatus() {
  try {
    const status = await api('/api/status');
    renderLiveStatus(status);
  } catch {
    renderLiveStatus(null);
  }
}

// --- Init ---
Promise.all([loadRepos(), loadEntities(), loadArchitectureGraph()]).catch(err => {
  entityListContent.innerHTML = `<div class="empty-state">Failed to connect<br><small>${escHtml(err.message)}</small></div>`;
});
pollLiveStatus();
setInterval(pollLiveStatus, 5000);
