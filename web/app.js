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
  Folder: '#484f58',
  Module: '#484f58',
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
  other: '#484f58',
};

let allEntities = [];
let graphNodes = [];
let graphLinks = [];
let simulation = null;
let selectedEntityId = null;
let currentView = 'architecture'; // 'architecture' or 'entity'

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
const backToArchBtn = document.getElementById('backToArch');

async function api(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function loadEntities() {
  const data = await api('/api/entities?limit=500');
  allEntities = data.entities || [];
  entityCount.textContent = `(${allEntities.length})`;
  statsEl.textContent = `${allEntities.length} entities`;
  renderEntityList(allEntities);
}

async function loadArchitectureGraph() {
  try {
    const data = await api('/api/graph/architecture');
    currentView = 'architecture';
    selectedEntityId = null;
    detailPanel.classList.add('hidden');
    
    // Build graph from architecture data
    const nodes = data.files.map(f => ({
      ...f,
      group: f.group,
      type: 'File',
    }));
    const links = data.links;
    
    graphNodes = nodes;
    graphLinks = links;
    renderArchitectureGraph();
  } catch (err) {
    console.error('Failed to load architecture graph:', err);
  }
}

function renderEntityList(entities) {
  if (!entities.length) {
    entityListContent.innerHTML = '<div class="empty-state">No entities found</div>';
    return;
  }
  entityListContent.innerHTML = entities.map(e => `
    <div class="entity-item${e.id === selectedEntityId ? ' selected' : ''}" data-id="${e.id}" data-stable-id="${e.stableId}">
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

function shortPath(p) {
  return p.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

function escHtml(s) {
  return s ? s.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
}

async function selectEntity(stableId) {
  selectedEntityId = stableId;
  const entity = allEntities.find(e => e.stableId === stableId);
  if (!entity) return;

  renderDetail(entity);
  detailPanel.classList.remove('hidden');

  entityListContent.querySelectorAll('.entity-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.stableId === stableId);
  });

  const depth = parseInt(depthSelect.value);
  await loadGraph(stableId, depth);
}

function renderDetail(entity) {
  detailTitle.textContent = entity.name;
  detailContent.innerHTML = `
    <div class="detail-row"><div class="label">Type</div><div class="value"><span class="type-badge type-${entity.type}">${entity.type}</span></div></div>
    <div class="detail-row"><div class="label">Language</div><div class="value">${entity.language}</div></div>
    <div class="detail-row"><div class="label">File</div><div class="value path">${escHtml(entity.filePath)}</div></div>
    <div class="detail-row"><div class="label">Lines</div><div class="value">${entity.startLine} - ${entity.endLine}</div></div>
    <div class="detail-row"><div class="label">Stable ID</div><div class="value" style="font-family:monospace;font-size:11px">${entity.stableId}</div></div>
    ${entity.purpose ? `<div class="detail-row"><div class="label">Purpose</div><div class="value">${escHtml(entity.purpose)}</div></div>` : ''}
    ${entity.responsibility ? `<div class="detail-row"><div class="label">Responsibility</div><div class="value">${escHtml(entity.responsibility)}</div></div>` : ''}
    <div class="detail-row"><div class="label">Exported</div><div class="value">${entity.isExported ? 'Yes' : 'No'}</div></div>
    <div class="detail-row"><div class="label">Confidence</div><div class="value">${(entity.confidence * 100).toFixed(0)}%</div></div>
  `;
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
      .text('Select an entity to view its graph');
    return;
  }

  const g = graphSvg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event) => {
    g.attr('transform', event.transform);
  });
  graphSvg.call(zoom);

  document.getElementById('zoomIn').onclick = () => graphSvg.transition().call(zoom.scaleBy, 1.3);
  document.getElementById('zoomOut').onclick = () => graphSvg.transition().call(zoom.scaleBy, 0.7);
  document.getElementById('zoomReset').onclick = () => graphSvg.transition().call(zoom.transform, d3.zoomIdentity);

  const defs = graphSvg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('class', 'link-arrow');

  simulation = d3.forceSimulation(graphNodes)
    .force('link', d3.forceLink(graphLinks).id(d => d.stableId).distance(100))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(30));

  const link = g.append('g')
    .selectAll('line')
    .data(graphLinks)
    .join('line')
    .attr('class', 'link')
    .attr('marker-end', 'url(#arrow)');

  const node = g.append('g')
    .selectAll('g')
    .data(graphNodes)
    .join('g')
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));

  node.append('circle')
    .attr('r', d => d.group === 'center' ? 12 : 8)
    .attr('fill', d => d.group === 'center' ? '#f0f6fc' : TYPE_COLORS[d.type] || '#484f58')
    .attr('stroke', d => d.group === 'center' ? '#58a6ff' : 'none')
    .attr('stroke-width', d => d.group === 'center' ? 3 : 0)
    .style('cursor', 'pointer')
    .on('click', (event, d) => selectEntity(d.stableId))
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mouseout', hideTooltip);

  node.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => (d.group === 'center' ? 12 : 8) + 14)
    .text(d => d.name.length > 20 ? d.name.slice(0, 18) + '..' : d.name);

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
}

function renderArchitectureGraph() {
  const container = document.getElementById('graphContainer');
  const width = container.clientWidth;
  const height = container.clientHeight;

  graphSvg.selectAll('*').remove();

  if (!graphNodes.length) {
    graphSvg.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', '#484f58')
      .text('Loading architecture...');
    return;
  }

  const g = graphSvg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event) => {
    g.attr('transform', event.transform);
  });
  graphSvg.call(zoom);

  document.getElementById('zoomIn').onclick = () => graphSvg.transition().call(zoom.scaleBy, 1.3);
  document.getElementById('zoomOut').onclick = () => graphSvg.transition().call(zoom.scaleBy, 0.7);
  document.getElementById('zoomReset').onclick = () => graphSvg.transition().call(zoom.transform, d3.zoomIdentity);

  // Arrow marker for import relationships
  const defs = graphSvg.append('defs');
  defs.append('marker')
    .attr('id', 'arrow-arch')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('class', 'link-arrow');

  simulation = d3.forceSimulation(graphNodes)
    .force('link', d3.forceLink(graphLinks).id(d => d.id).distance(150))
    .force('charge', d3.forceManyBody().strength(-500))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => Math.max(20, d.entityCount * 3)));

  const link = g.append('g')
    .selectAll('line')
    .data(graphLinks)
    .join('line')
    .attr('class', 'link')
    .attr('marker-end', 'url(#arrow-arch)');

  const node = g.append('g')
    .selectAll('g')
    .data(graphNodes)
    .join('g')
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));

  // File nodes - sized by entity count
  node.append('circle')
    .attr('r', d => Math.max(8, Math.min(25, d.entityCount * 2)))
    .attr('fill', d => GROUP_COLORS[d.group] || '#484f58')
    .attr('stroke', '#0d1117')
    .attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .on('click', (event, d) => selectFile(d.fullPath))
    .on('mouseover', (event, d) => showFileTooltip(event, d))
    .on('mouseout', hideTooltip);

  node.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => Math.max(8, Math.min(25, d.entityCount * 2)) + 14)
    .text(d => d.name.length > 25 ? d.name.slice(0, 23) + '..' : d.name);

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
  function dragended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
}

async function selectFile(filePath) {
  currentView = 'entity';
  // Find entities in this file
  const fileEntities = allEntities.filter(e => e.filePath === filePath);
  if (fileEntities.length > 0) {
    // Show first entity from file
    await selectEntity(fileEntities[0].stableId);
  }
}

function showFileTooltip(event, d) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.innerHTML = `
    <strong>${escHtml(d.name)}</strong><br>
    <span style="color:${GROUP_COLORS[d.group] || '#8b949e'}">${d.group}</span><br>
    <span style="color:#8b949e">${d.entityCount} entities</span><br>
    <span style="color:#8b949e;font-size:11px">${d.entityTypes.slice(0, 5).join(', ')}</span>
  `;
  tooltipEl.style.display = 'block';
  tooltipEl.style.left = (event.pageX + 12) + 'px';
  tooltipEl.style.top = (event.pageY - 10) + 'px';
}

let tooltipEl = null;
function showTooltip(event, d) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.innerHTML = `
    <strong>${escHtml(d.name)}</strong><br>
    <span style="color:${TYPE_COLORS[d.type] || '#8b949e'}">${d.type}</span><br>
    <span style="color:#8b949e">${escHtml(shortPath(d.filePath))}</span>
  `;
  tooltipEl.style.display = 'block';
  tooltipEl.style.left = (event.pageX + 12) + 'px';
  tooltipEl.style.top = (event.pageY - 10) + 'px';
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

searchBtn.addEventListener('click', async () => {
  const q = searchInput.value.trim();
  if (!q) { renderEntityList(allEntities); return; }
  try {
    const data = await api(`/api/entities/search/${encodeURIComponent(q)}`);
    renderEntityList(data.entities || []);
  } catch { renderEntityList([]); }
});

searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchBtn.click(); });

closeDetail.addEventListener('click', () => {
  detailPanel.classList.add('hidden');
  selectedEntityId = null;
  if (currentView === 'entity') {
    loadArchitectureGraph();
  }
});

backToArchBtn.addEventListener('click', () => {
  loadArchitectureGraph();
});

depthSelect.addEventListener('change', () => {
  if (selectedEntityId) {
    loadGraph(selectedEntityId, parseInt(depthSelect.value));
  }
});

// Initialize: load entities list and architecture graph
Promise.all([loadEntities(), loadArchitectureGraph()]).catch(err => {
  entityListContent.innerHTML = `<div class="empty-state">Failed to connect to API<br><small>${err.message}</small></div>`;
});
