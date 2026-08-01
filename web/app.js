const API_BASE = 'http://localhost:3000';

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

// DOM refs
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
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

// --- API ---
async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// --- Utilities ---
function escHtml(s) {
  return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
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
      currentView = 'architecture';
      loadArchitectureGraph();
    } else if (view === 'commits') {
      entityPanel.classList.add('hidden');
      commitPanel.classList.remove('hidden');
      currentView = 'commits';
      loadCommits();
    }
  });
});

// --- Entities ---
async function loadEntities() {
  try {
    const data = await api('/api/entities?limit=1000');
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
    <div class="entity-item${e.stableId === selectedEntityId ? ' selected' : ''}" data-stable-id="${e.stableId}">
      <div class="name">
        <span class="type-badge type-${e.type}">${e.type}</span>
        ${escHtml(e.name)}
      </div>
      <div class="meta">${escHtml(shortPath(e.filePath))}</div>
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
    const data = await api(`/api/entities/search/${encodeURIComponent(q)}`);
    renderEntityList(data.entities || []);
  } catch { renderEntityList([]); }
});

searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });

// --- Entity selection & detail ---
async function selectEntity(stableId) {
  selectedEntityId = stableId;
  const entity = allEntities.find(e => e.stableId === stableId);
  if (!entity) return;

  entityListContent.querySelectorAll('.entity-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.stableId === stableId);
  });

  detailPanel.classList.remove('hidden');
  renderDetail(entity);

  const depth = parseInt(depthSelect.value);
  showGraphLoading();
  await Promise.all([
    loadGraph(stableId, depth),
    loadImpactAnalysis(stableId),
    loadSimilarEntities(stableId),
    loadContextPack(stableId),
  ]);
  hideGraphLoading();
}

function renderDetail(entity) {
  detailTitle.textContent = entity.name;

  let html = '';

  // Core info
  html += `<div class="detail-section">
    <h3>Info</h3>
    <div class="detail-row"><div class="label">Type</div><div class="value"><span class="type-badge type-${entity.type}">${entity.type}</span></div></div>
    <div class="detail-row"><div class="label">Language</div><div class="value">${entity.language}</div></div>
    <div class="detail-row"><div class="label">File</div><div class="value path">${escHtml(entity.filePath)}</div></div>
    <div class="detail-row"><div class="label">Lines</div><div class="value">${entity.startLine}&ndash;${entity.endLine}</div></div>
    <div class="detail-row"><div class="label">Exported</div><div class="value">${entity.isExported ? 'Yes' : 'No'}</div></div>
    <div class="detail-row"><div class="label">Confidence</div><div class="value">${(entity.confidence * 100).toFixed(0)}%</div></div>
    ${entity.purpose ? `<div class="detail-row"><div class="label">Purpose</div><div class="value">${escHtml(entity.purpose)}</div></div>` : ''}
    ${entity.responsibility ? `<div class="detail-row"><div class="label">Responsibility</div><div class="value">${escHtml(entity.responsibility)}</div></div>` : ''}
  </div>`;

  // Stable ID
  html += `<div class="detail-section">
    <h3>Identity</h3>
    <div class="detail-row"><div class="value mono">${escHtml(entity.stableId)}</div></div>
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

  detailContent.innerHTML = html;
}

closeDetail.addEventListener('click', () => {
  detailPanel.classList.add('hidden');
  selectedEntityId = null;
  entityListContent.querySelectorAll('.entity-item').forEach(el => el.classList.remove('selected'));
  if (currentView === 'architecture') loadArchitectureGraph();
});

// --- Graph ---
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
      showTooltip(`<strong>${escHtml(d.name)}</strong><br><span style="color:${TYPE_COLORS[d.type] || '#8b949e'}">${d.type}</span><br><span style="color:#8b949e">${escHtml(shortPath(d.filePath))}</span>`, e);
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
    const data = await api('/api/graph/architecture');
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
      showTooltip(`<strong>${escHtml(d.name)}</strong><br><span style="color:${GROUP_COLORS[d.group] || '#8b949e'}">${d.group}</span><br><span style="color:#8b949e">${d.entityCount} entities</span><br><span style="color:#8b949e;font-size:10px">${(d.entityTypes || []).slice(0, 4).join(', ')}</span>`, e);
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
    const data = await api('/api/commits?limit=50');
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
    <div class="commit-item${c.hash === selectedCommitHash ? ' selected' : ''}" data-hash="${c.hash}">
      <div class="hash">${c.hash.slice(0, 8)}</div>
      <div class="msg">${escHtml(c.message)}</div>
      <div class="meta">
        <span>${escHtml(c.author)}</span>
        <span>${timeAgo(c.timestamp)}</span>
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
          <span class="status ${fc.changeType}">${fc.changeType}</span>
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
          <li class="similar-item" data-stable-id="${s.stableId}">
            <span class="type-badge type-${s.type}">${s.type}</span>
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
    const content = data.packedContent || data.content || '';
    const tokens = data.totalTokens || 0;
    section.innerHTML = `
      <h3>Context Pack <span style="font-weight:400;text-transform:none;color:#8b949e">${tokens} tokens</span></h3>
      <div class="context-pack">${escHtml(content.slice(0, 3000))}</div>
    `;
  } catch {
    section.innerHTML = '<h3>Context Pack</h3><div class="empty-state">Unavailable</div>';
  }
}

// --- Init ---
Promise.all([loadEntities(), loadArchitectureGraph()]).catch(err => {
  entityListContent.innerHTML = `<div class="empty-state">Failed to connect<br><small>${escHtml(err.message)}</small></div>`;
});
