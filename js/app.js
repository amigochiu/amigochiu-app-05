// ==========================================
// 台灣鄉鎮踩點收集冊 - 主程式邏輯
// ==========================================

// 全域狀態管理
const state = {
    geoData: null,
    hierarchy: {},
    visited: {},
    openCounties: {},
    totalTownsCount: 0,
    dimensions: { width: 800, height: 600 },
    hoveredTown: '',
    pathGenerator: null,
    zoomBehavior: null
};

// DOM 元素參考
const dom = {
    container: document.getElementById('map-container'),
    svg: d3.select('#map-svg'),
    g: d3.select('#map-g'),
    loadingOverlay: document.getElementById('loading-overlay'),
    errorOverlay: document.getElementById('error-overlay'),
    errorMessage: document.getElementById('error-message'),
    btnReload: document.getElementById('btn-reload'),
    hoverTooltip: document.getElementById('hover-tooltip'),
    hoverTownName: document.getElementById('hover-town-name'),
    interactionHint: document.getElementById('interaction-hint'),
    progressText: document.getElementById('progress-text'),
    progressBar: document.getElementById('progress-bar'),
    townListContainer: document.getElementById('town-list-container'),
    btnCollapseAll: document.getElementById('btn-collapse-all'),
    btnExpandAll: document.getElementById('btn-expand-all'),
    btnResetPrompt: document.getElementById('btn-reset-prompt'),
    resetConfirmBox: document.getElementById('reset-confirm-box'),
    btnResetYes: document.getElementById('btn-reset-yes'),
    btnResetNo: document.getElementById('btn-reset-no'),
    btnExportPng: document.getElementById('btn-export-png'),
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnImportCsv: document.getElementById('btn-import-csv'),
    inputImportCsv: document.getElementById('input-import-csv')
};

// ==========================================
// 輔助函式
// ==========================================
const getRandomColor = () => `hsl(${Math.floor(Math.random() * 360)}, 75%, 68%)`;

function showError(msg) {
    dom.errorMessage.textContent = msg;
    dom.errorOverlay.classList.remove('hidden');
    dom.loadingOverlay.classList.add('hidden');
}

function updateDimensions() {
    if (!dom.container) return;
    const rect = dom.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        state.dimensions.width = rect.width;
        state.dimensions.height = rect.height;
    }
}

// ==========================================
// 地圖資料處理與載入
// ==========================================
async function loadMapData() {
    try {
        const urls = [
            'https://cdn.jsdelivr.net/gh/JiaAnTW/taiwan_geojson@master/taiwan_towns.json',
            'https://cdn.jsdelivr.net/gh/yochien/taiwan-geojson@master/tw-town.json',
            'https://cdn.jsdelivr.net/gh/shihjen/D3-Taiwan-Map@master/taiwan_town_simplify.json',
            'https://cdn.jsdelivr.net/gh/ronnywang/twgeojson@master/twtown2010.3.json'
        ];
        
        let data = null;
        for (let url of urls) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const parsedData = await res.json();
                    if (parsedData && Array.isArray(parsedData.features)) {
                        data = parsedData;
                        console.log(`成功載入圖資: ${url}`);
                        break;
                    }
                }
            } catch (e) {
                console.warn(`無法從 ${url} 載入資料，嘗試下一個來源...`);
            }
        }

        if (!data || !data.features) {
            throw new Error('無法從公開來源取得有效的台灣地圖資料 (GeoJSON)');
        }

        // 處理梧棲區破碎問題
        const wuqiFeatures = data.features.filter(f => {
            if (!f.properties) return false;
            const p = f.properties;
            const c = (p.COUNTYNAME || p.COUNTY || p.county || p.C_Name || p.COUNTY_NAM || p.County_Nam || '').replace('台', '臺');
            const t = p.TOWNNAME || p.TOWN || p.town || p.T_Name || p.TOWN_NAM || p.Town_Name;
            return c === '臺中市' && t === '梧棲區';
        });

        if (wuqiFeatures.length > 1) {
            let maxArea = -1;
            let mainFeature = null;
            wuqiFeatures.forEach(f => {
                const area = d3.geoArea(f.geometry);
                if (area > maxArea) {
                    maxArea = area;
                    mainFeature = f;
                }
            });
            wuqiFeatures.forEach(f => {
                if (f !== mainFeature) {
                    const p = f.properties;
                    p.TOWNNAME = '清水區';
                    p.TOWN = '清水區';
                    p.town = '清水區';
                    p.T_Name = '清水區';
                }
            });
        }

        // 使用 Turf.js 自動合併破碎區塊
        if (typeof turf !== 'undefined') {
            try {
                const featureGroups = {};
                data.features.forEach(f => {
                    if (!f.properties) return;
                    const p = f.properties;
                    let c = (p.COUNTYNAME || p.COUNTY || p.county || p.C_Name || p.COUNTY_NAM || p.County_Nam || '').replace('台', '臺');
                    let t = p.TOWNNAME || p.TOWN || p.town || p.T_Name || p.TOWN_NAM || p.Town_Name;
                    if (!c || !t) return;
                    
                    const id = `${c}_${t}`;
                    if (!featureGroups[id]) featureGroups[id] = [];
                    featureGroups[id].push(f);
                });

                for (const [id, feats] of Object.entries(featureGroups)) {
                    if (feats.length > 1) {
                        let mergedFeature = JSON.parse(JSON.stringify(feats[0]));
                        for (let i = 1; i < feats.length; i++) {
                            const nextFeature = feats[i];
                            if (mergedFeature.geometry && nextFeature.geometry) {
                                try {
                                    const res = turf.union(mergedFeature, nextFeature);
                                    if (res && res.geometry) {
                                        let finalGeom = res.geometry;
                                        if (finalGeom.type === 'GeometryCollection') {
                                            const polys = finalGeom.geometries.filter(g => g.type === 'Polygon' || g.type === 'MultiPolygon');
                                            if (polys.length > 0) finalGeom = polys[0];
                                        }
                                        res.geometry = finalGeom;
                                        res.properties = { ...mergedFeature.properties }; 
                                        mergedFeature = res;
                                    }
                                } catch (err) {
                                    console.warn(`Turf 聯集單步失敗 (${id})`, err);
                                }
                            }
                        }
                        
                        if (mergedFeature && mergedFeature.properties) {
                            data.features = data.features.filter(f => !feats.includes(f));
                            const [cName, tName] = id.split('_');
                            mergedFeature.properties.COUNTYNAME = cName;
                            mergedFeature.properties.COUNTY = cName;
                            mergedFeature.properties.TOWNNAME = tName;
                            mergedFeature.properties.TOWN = tName;
                            data.features.push(mergedFeature);
                        }
                    }
                }
            } catch (e) {
                console.warn("Turf.js 處理失敗，將維持原狀", e);
            }
        }

        const tree = {};
        const validFeatures = [];
        const offshoreCounties = ['澎湖縣', '金門縣', '連江縣'];
        const offshoreTowns = [
            '東沙群島', '南沙群島', '釣魚臺', '釣魚臺列嶼', '釣魚台', '龜山島',
            '旗津區(海)', '龍井區(海)', '清水區(海)', '梧棲區(海)',
            '小港區(海)', '前鎮區(海)', '鼓山區(海)'
        ];

        data.features.forEach(feature => {
            if (!feature.properties) return;
            
            const props = feature.properties;
            let county = props.COUNTYNAME || props.COUNTY || props.county || props.C_Name || props.COUNTY_NAM || props.County_Nam;
            let town = props.TOWNNAME || props.TOWN || props.town || props.T_Name || props.TOWN_NAM || props.Town_Name;
            
            if (!county || !town) return;
            
            county = county.replace('台', '臺'); 
            
            // 桃園市升格直轄市，轄下鄉鎮市皆改制為區
            if (county === '桃園縣' || county === '桃園市') {
                county = '桃園市';
                town = town.replace(/[市鎮鄉]$/, '區');
            }
            
            if (offshoreCounties.includes(county) || offshoreTowns.includes(town)) return;

            const uniqueTownId = `${county}_${town}`;

            // 修復 Winding Order
            const featureCopy = JSON.parse(JSON.stringify(feature));
            if (featureCopy.geometry && featureCopy.geometry.coordinates) {
                const fixWinding = (polyCoords) => {
                    if (d3.geoArea({ type: 'Polygon', coordinates: polyCoords }) > 6) {
                        polyCoords.forEach(ring => ring.reverse());
                    }
                };
                
                if (featureCopy.geometry.type === 'Polygon') {
                    fixWinding(featureCopy.geometry.coordinates);
                } else if (featureCopy.geometry.type === 'MultiPolygon') {
                    featureCopy.geometry.coordinates.forEach(poly => fixWinding(poly));
                }

                const townsToKeepMainLand = [
                    { c: '雲林縣', t: '口湖鄉' },
                    { c: '彰化縣', t: '鹿港鎮' },
                    { c: '彰化縣', t: '線西鄉' },
                    { c: '嘉義縣', t: '東石鄉' },
                    { c: '臺中市', t: '梧棲區' },
                    { c: '臺中市', t: '龍井區' } 
                ];
                
                const shouldKeepMain = townsToKeepMainLand.some(item => item.c === county && item.t === town);

                if (shouldKeepMain && featureCopy.geometry.type === 'MultiPolygon') {
                    let maxArea = -1;
                    let mainPoly = null;
                    featureCopy.geometry.coordinates.forEach(poly => {
                        const area = d3.geoArea({ type: 'Polygon', coordinates: poly });
                        if (area > maxArea) {
                            maxArea = area;
                            mainPoly = poly;
                        }
                    });
                    if (mainPoly) {
                        featureCopy.geometry.type = 'Polygon';
                        featureCopy.geometry.coordinates = mainPoly;
                    }
                }
            }

            validFeatures.push({
                ...featureCopy,
                id: uniqueTownId,
                featureIndex: validFeatures.length,
                properties: {
                    ...props,
                    countyName: county,
                    townName: town
                }
            });

            if (!tree[county]) tree[county] = [];
            if (!tree[county].find(t => t.id === uniqueTownId)) {
                tree[county].push({ id: uniqueTownId, name: town });
            }
        });

        const countyOrder = [
            '基隆市','臺北市','新北市','桃園市','新竹縣','新竹市',
            '苗栗縣','臺中市','彰化縣','南投縣','雲林縣','嘉義縣',
            '嘉義市','臺南市','高雄市','屏東縣','宜蘭縣','花蓮縣','臺東縣'
        ];
        
        const sortedTree = {};
        countyOrder.forEach(c => {
            if (tree[c]) sortedTree[c] = tree[c].sort((a, b) => a.name.localeCompare(b.name));
        });
        Object.keys(tree).forEach(c => {
            if (!sortedTree[c]) sortedTree[c] = tree[c].sort((a, b) => a.name.localeCompare(b.name));
        });

        state.hierarchy = sortedTree;
        state.geoData = { type: 'FeatureCollection', features: validFeatures };
        
        // 計算總鄉鎮數
        state.totalTownsCount = Object.values(state.hierarchy).reduce((acc, towns) => acc + towns.length, 0);

        // 預設全收合
        state.openCounties = {};
        Object.keys(state.hierarchy).forEach(c => state.openCounties[c] = false);

        // 隱藏載入中遮罩
        dom.loadingOverlay.classList.add('hidden');
        dom.interactionHint.classList.remove('hidden');

        // 從 localStorage 讀取進度 (選用)
        const saved = localStorage.getItem('visitedTowns');
        if (saved) {
            try {
                state.visited = JSON.parse(saved);
            } catch (e) {
                console.error('還原儲存進度失敗', e);
            }
        }

        initMap();
        renderSidebar();
        updateProgress();

    } catch (err) {
        console.error("Map Data Load Error:", err);
        showError(err.message);
    }
}

// ==========================================
// D3 地圖繪製
// ==========================================
function initMap() {
    updateDimensions();
    const w = state.dimensions.width;
    const h = state.dimensions.height;
    
    const scale = Math.min(w, h) * 12; 
    
    const projection = d3.geoMercator()
        .center([120.9, 23.7])
        .scale(scale)
        .translate([w / 2, h / 2]);

    state.pathGenerator = d3.geoPath().projection(projection);

    // 設定縮放
    state.zoomBehavior = d3.zoom()
        .scaleExtent([0.8, 15])
        .on('zoom', (event) => {
            dom.g.attr('transform', event.transform);
        });
    dom.svg.call(state.zoomBehavior);

    renderMapPaths();
}

function renderMapPaths() {
    // 綁定資料
    const paths = dom.g.selectAll('path')
        .data(state.geoData.features, d => d.id);

    // Enter
    paths.enter()
        .append('path')
        .attr('class', 'map-path')
        .attr('d', state.pathGenerator)
        .attr('fill', d => state.visited[d.id] ? state.visited[d.id] : '#cbd5e1')
        .on('click', (event, d) => handleTownClick(d.id))
        .on('mouseenter', (event, d) => {
            state.hoveredTown = `${d.properties.countyName} ${d.properties.townName}`;
            dom.hoverTownName.textContent = state.hoveredTown;
            dom.hoverTooltip.style.opacity = '1';
        })
        .on('mouseleave', () => {
            state.hoveredTown = '';
            dom.hoverTownName.textContent = '請選擇鄉鎮';
        })
        .append('title')
        .text(d => `${d.properties.countyName} ${d.properties.townName}`);

    // Update (若是重新渲染)
    paths
        .attr('d', state.pathGenerator)
        .attr('fill', d => state.visited[d.id] ? state.visited[d.id] : '#cbd5e1');

    paths.exit().remove();
}

function updateMapColors() {
    dom.g.selectAll('path')
        .attr('fill', d => state.visited[d.id] ? state.visited[d.id] : '#cbd5e1');
}

// ==========================================
// 互動與更新邏輯
// ==========================================
function handleTownClick(townId) {
    if (state.visited[townId]) {
        delete state.visited[townId];
    } else {
        state.visited[townId] = getRandomColor();
    }
    // 儲存進度
    localStorage.setItem('visitedTowns', JSON.stringify(state.visited));
    
    updateMapColors();
    renderSidebar(); // 更新右側按鈕樣式
    updateProgress();
}

function toggleCounty(county) {
    state.openCounties[county] = !state.openCounties[county];
    renderSidebar();
}

function updateProgress() {
    const visitedCount = Object.keys(state.visited).length;
    const progressPercentage = state.totalTownsCount > 0 ? (visitedCount / state.totalTownsCount) * 100 : 0;
    
    dom.progressText.textContent = `${visitedCount} / ${state.totalTownsCount}`;
    dom.progressBar.style.width = `${progressPercentage}%`;
}

// ==========================================
// 側邊欄渲染 (使用 Template Literals 與 DocumentFragment)
// ==========================================
function renderSidebar() {
    // 檢查全部展開/收合狀態
    const totalCountiesCount = Object.keys(state.hierarchy).length;
    const openCountiesCount = Object.values(state.openCounties).filter(Boolean).length;
    const isAllCollapsed = totalCountiesCount > 0 && openCountiesCount === 0;
    const isAllExpanded = totalCountiesCount > 0 && openCountiesCount === totalCountiesCount;

    // 更新頂端按鈕樣式
    if (isAllCollapsed) {
        dom.btnCollapseAll.className = 'flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200 border bg-slate-700 text-white border-slate-700 shadow-md';
    } else {
        dom.btnCollapseAll.className = 'flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200 border bg-white text-gray-500 border-gray-200 hover:bg-gray-50';
    }

    if (isAllExpanded) {
        dom.btnExpandAll.className = 'flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200 border bg-blue-600 text-white border-blue-600 shadow-md';
    } else {
        dom.btnExpandAll.className = 'flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200 border bg-white text-gray-500 border-gray-200 hover:bg-gray-50';
    }

    // 清空舊容器內容
    dom.townListContainer.innerHTML = '';

    if (totalCountiesCount === 0) {
        dom.townListContainer.innerHTML = '<div class="text-center text-gray-500 py-10">無法解析鄉鎮列表資料</div>';
        return;
    }

    Object.entries(state.hierarchy).forEach(([county, towns]) => {
        const visitedCount = towns.filter(t => state.visited[t.id]).length;
        const isAllVisited = visitedCount === towns.length && towns.length > 0;
        const isOpen = state.openCounties[county];

        const countyWrapper = document.createElement('div');
        countyWrapper.className = `border rounded-xl overflow-hidden transition-all duration-200 ${isOpen ? 'shadow-md border-blue-200/60' : 'border-gray-200'}`;
        
        // 縣市按鈕
        const btnHeader = document.createElement('button');
        btnHeader.className = `w-full px-4 py-3 flex justify-between items-center transition-colors ${isAllVisited ? 'bg-red-50/50 hover:bg-red-100/50' : isOpen ? 'bg-blue-50/40 hover:bg-blue-50/80' : 'bg-white hover:bg-gray-50'}`;
        btnHeader.onclick = () => toggleCounty(county);
        
        btnHeader.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="font-bold text-gray-800 text-lg tracking-wide">${county}</span>
                ${isAllVisited ? '<span class="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">完霸</span>' : ''}
            </div>
            <div class="flex items-center gap-3">
                <span class="text-sm font-bold ${isAllVisited ? 'text-red-600' : visitedCount > 0 ? 'text-blue-600' : 'text-gray-400'}">
                    ${visitedCount} / ${towns.length}
                </span>
                <svg class="w-5 h-5 text-gray-400 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
            </div>
        `;
        countyWrapper.appendChild(btnHeader);

        // 鄉鎮清單網格
        const grid = document.createElement('div');
        grid.className = `grid grid-cols-3 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-3 gap-2 px-3 py-3 bg-white border-t border-gray-100 transition-all origin-top ${isOpen ? 'block' : 'hidden'}`;
        
        towns.forEach(town => {
            const isVisited = !!state.visited[town.id];
            const btnTown = document.createElement('button');
            
            btnTown.textContent = town.name;
            btnTown.title = town.name;
            
            if (isVisited) {
                btnTown.className = 'text-sm py-2 px-1 rounded-lg transition-all duration-200 ease-in-out font-medium truncate text-slate-800 shadow-md transform hover:scale-105 active:scale-95';
                btnTown.style.backgroundColor = state.visited[town.id];
                btnTown.style.borderColor = 'transparent';
            } else {
                btnTown.className = 'text-sm py-2 px-1 rounded-lg transition-all duration-200 ease-in-out font-medium truncate bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100 hover:border-gray-300 active:bg-gray-200';
            }
            
            btnTown.onclick = () => handleTownClick(town.id);
            grid.appendChild(btnTown);
        });

        countyWrapper.appendChild(grid);
        dom.townListContainer.appendChild(countyWrapper);
    });
}

// ==========================================
// 匯出功能
// ==========================================
function exportCSV() {
    let csvContent = '\uFEFF'; // UTF-8 BOM，讓 Excel 正確顯示中文
    csvContent += '縣市,市鎮鄉,去過沒去過\n';

    Object.entries(state.hierarchy).forEach(([county, towns]) => {
        towns.forEach(town => {
            const visitedMark = state.visited[town.id] ? '✓' : '';
            csvContent += `${county},${town.name},${visitedMark}\n`;
        });
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '台灣鄉鎮踩點收集冊.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function importCSV(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        const rows = text.split('\n');
        let importedCount = 0;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i].trim();
            if (!row) continue;
            
            const cols = row.split(',');
            if (cols.length >= 3) {
                const county = cols[0].replace(/^"|"$/g, '').trim();
                const town = cols[1].replace(/^"|"$/g, '').trim();
                const visited = cols[2].replace(/^"|"$/g, '').trim();
                
                if (visited === '✓' || visited === 'V' || visited === 'v' || visited === '1' || visited.toLowerCase() === 'true') {
                    const townId = `${county}_${town}`;
                    // 檢查資料結構中是否有該鄉鎮，並確認尚未被標記
                    if (!state.visited[townId] && state.hierarchy[county] && state.hierarchy[county].find(t => t.id === townId)) {
                        state.visited[townId] = getRandomColor();
                        importedCount++;
                    }
                }
            }
        }
        
        if (importedCount > 0) {
             localStorage.setItem('visitedTowns', JSON.stringify(state.visited));
             updateMapColors();
             updateProgress();
             renderSidebar();
             alert(`成功匯入！共新增了 ${importedCount} 筆踩點資料。`);
        } else if (rows.length > 1) {
             alert('匯入完成。未新增踩點紀錄（現有資料不受影響）。');
        } else {
             alert('無法匯入，檔案格式不正確或為空檔案。');
        }
        
        event.target.value = ''; // 清空 input 讓下次可選同一個檔案
    };
    reader.readAsText(file);
}

function exportPNG() {
    // 取得 SVG 元素
    const svgElement = dom.svg.node();
    
    // 將 SVG 轉為字串前，先強制寫入白邊樣式以確保圖片顯示正常
    const paths = svgElement.querySelectorAll('.map-path');
    paths.forEach(p => {
        p.style.stroke = '#ffffff';
        p.style.strokeWidth = '0.3px';
    });

    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(svgElement);
    
    // 轉換回原本的行內樣式狀態 (避免殘留影響後續 hover)
    paths.forEach(p => {
        p.style.stroke = '';
        p.style.strokeWidth = '';
    });

    // 補上 xmlns 宣告確保相容性
    if (!svgString.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
        svgString = svgString.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const DOMURL = window.URL || window.webkitURL || window;
    const url = DOMURL.createObjectURL(svgBlob);

    const image = new Image();
    image.onload = function() {
        const canvas = document.createElement('canvas');
        canvas.width = state.dimensions.width * 2; // 提高解析度
        canvas.height = state.dimensions.height * 2;
        const ctx = canvas.getContext('2d');
        
        // 填滿背景色 (選用偏藍的背景)
        ctx.fillStyle = '#e3f2fd';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // 放大繪製
        ctx.scale(2, 2);
        ctx.drawImage(image, 0, 0);
        
        // --- 新增：繪製標題與進度條 ---
        const padding = 20;
        const panelX = 20;
        const panelY = 20;
        const panelWidth = 280;
        const panelHeight = 110;
        
        // 繪製半透明白色圓角背景
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 4;
        
        // 相容性寫法繪製圓角矩形
        const r = 8;
        ctx.beginPath();
        ctx.moveTo(panelX + r, panelY);
        ctx.lineTo(panelX + panelWidth - r, panelY);
        ctx.quadraticCurveTo(panelX + panelWidth, panelY, panelX + panelWidth, panelY + r);
        ctx.lineTo(panelX + panelWidth, panelY + panelHeight - r);
        ctx.quadraticCurveTo(panelX + panelWidth, panelY + panelHeight, panelX + panelWidth - r, panelY + panelHeight);
        ctx.lineTo(panelX + r, panelY + panelHeight);
        ctx.quadraticCurveTo(panelX, panelY + panelHeight, panelX, panelY + panelHeight - r);
        ctx.lineTo(panelX, panelY + r);
        ctx.quadraticCurveTo(panelX, panelY, panelX + r, panelY);
        ctx.closePath();
        ctx.fill();
        
        ctx.shadowColor = 'transparent'; // 重置陰影

        // 標題文字
        ctx.fillStyle = '#1f2937';
        ctx.font = 'bold 22px "Microsoft JhengHei", "PingFang TC", sans-serif';
        ctx.fillText('台灣鄉鎮收集冊', panelX + padding, panelY + padding + 18);

        // 取得進度資料
        const visitedCount = Object.keys(state.visited).length;
        const total = state.totalTownsCount;
        const progressPercentage = total > 0 ? (visitedCount / total) * 100 : 0;

        // 進度文字
        ctx.fillStyle = '#4b5563';
        ctx.font = '600 15px "Microsoft JhengHei", "PingFang TC", sans-serif';
        ctx.fillText('總收集進度', panelX + padding, panelY + padding + 52);

        ctx.fillStyle = '#2563eb';
        ctx.font = 'bold 15px "Microsoft JhengHei", "PingFang TC", sans-serif';
        const progressText = `${visitedCount} / ${total}`;
        const textWidth = ctx.measureText(progressText).width;
        ctx.fillText(progressText, panelX + panelWidth - padding - textWidth, panelY + padding + 52);

        // 進度條背景
        const barX = panelX + padding;
        const barY = panelY + padding + 65;
        const barWidth = panelWidth - padding * 2;
        const barHeight = 10;
        const barRadius = 5;
        
        ctx.fillStyle = '#f3f4f6';
        ctx.beginPath();
        ctx.moveTo(barX + barRadius, barY);
        ctx.lineTo(barX + barWidth - barRadius, barY);
        ctx.quadraticCurveTo(barX + barWidth, barY, barX + barWidth, barY + barRadius);
        ctx.lineTo(barX + barWidth, barY + barHeight - barRadius);
        ctx.quadraticCurveTo(barX + barWidth, barY + barHeight, barX + barWidth - barRadius, barY + barHeight);
        ctx.lineTo(barX + barRadius, barY + barHeight);
        ctx.quadraticCurveTo(barX, barY + barHeight, barX, barY + barHeight - barRadius);
        ctx.lineTo(barX, barY + barRadius);
        ctx.quadraticCurveTo(barX, barY, barX + barRadius, barY);
        ctx.closePath();
        ctx.fill();

        // 實際進度條
        if (progressPercentage > 0) {
            const currentBarWidth = Math.max(barRadius * 2, barWidth * (progressPercentage / 100));
            const gradient = ctx.createLinearGradient(barX, barY, barX + barWidth, barY);
            gradient.addColorStop(0, '#60a5fa');
            gradient.addColorStop(1, '#2563eb');
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(barX + barRadius, barY);
            ctx.lineTo(barX + currentBarWidth - barRadius, barY);
            ctx.quadraticCurveTo(barX + currentBarWidth, barY, barX + currentBarWidth, barY + barRadius);
            ctx.lineTo(barX + currentBarWidth, barY + barHeight - barRadius);
            ctx.quadraticCurveTo(barX + currentBarWidth, barY + barHeight, barX + currentBarWidth - barRadius, barY + barHeight);
            ctx.lineTo(barX + barRadius, barY + barHeight);
            ctx.quadraticCurveTo(barX, barY + barHeight, barX, barY + barHeight - barRadius);
            ctx.lineTo(barX, barY + barRadius);
            ctx.quadraticCurveTo(barX, barY, barX + barRadius, barY);
            ctx.closePath();
            ctx.fill();
        }
        
        DOMURL.revokeObjectURL(url);

        const imgURI = canvas.toDataURL('image/png');
        
        const link = document.createElement('a');
        link.href = imgURI;
        link.download = '台灣地圖踩點紀錄.png';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };
    image.src = url;
}

// ==========================================
// 事件綁定
// ==========================================
function setupEvents() {
    dom.btnReload.addEventListener('click', () => window.location.reload());
    
    dom.btnCollapseAll.addEventListener('click', () => {
        Object.keys(state.openCounties).forEach(c => state.openCounties[c] = false);
        renderSidebar();
    });

    dom.btnExpandAll.addEventListener('click', () => {
        Object.keys(state.openCounties).forEach(c => state.openCounties[c] = true);
        renderSidebar();
    });

    dom.btnResetPrompt.addEventListener('click', () => {
        dom.btnResetPrompt.classList.add('hidden');
        dom.resetConfirmBox.classList.remove('hidden');
    });

    dom.btnResetNo.addEventListener('click', () => {
        dom.btnResetPrompt.classList.remove('hidden');
        dom.resetConfirmBox.classList.add('hidden');
    });

    dom.btnResetYes.addEventListener('click', () => {
        state.visited = {};
        localStorage.removeItem('visitedTowns');
        updateMapColors();
        updateProgress();
        renderSidebar();
        dom.btnResetPrompt.classList.remove('hidden');
        dom.resetConfirmBox.classList.add('hidden');
    });

    dom.btnExportCsv.addEventListener('click', exportCSV);
    dom.btnExportPng.addEventListener('click', exportPNG);
    dom.btnImportCsv.addEventListener('click', () => dom.inputImportCsv.click());
    dom.inputImportCsv.addEventListener('change', importCSV);

    // 視窗大小改變時重新計算 D3 投影 (加上 Debounce)
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (state.geoData) {
                initMap();
            }
        }, 300);
    });
}

// ==========================================
// 初始化執行
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    setupEvents();
    loadMapData();
});
