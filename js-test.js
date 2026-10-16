/* =========================================================
   js-test.js  ─  ④単語テスト・苦手単語・成績
   ---------------------------------------------------------
   【こんなときに、このファイルを開く】
    ・苦手単語リストの登録・復習の動きを直したい
    ・単語テスト（モーダル画面）の動きを直したい
    ・成績の入力・一覧・グラフを直したい
    ・※ AIによる弱点分析・学習計画は js-ai-features.js
   【読み込み順】 ⑦ js-common.js の後
   ※ 中身のコードは、分割前の js-app.js と同一です（場所を移しただけ）。
========================================================= */

/* ───────── 苦手単語（リーチ） ───────── */
/* ---------- leech words (shared) ---------- */

async function loadLeech(){
  leechWords = loadFromStorage(LEECH_KEY);
}
async function saveLeech(){
  saveToStorage(LEECH_KEY, leechWords);
}

function nextDateForStep(step){
  const idx = Math.min(step, DEFAULT_INTERVALS.length - 1);
  return formatISO(addDays(new Date(), DEFAULT_INTERVALS[idx]));
}

async function handleLeechAdd(){
  const wordEl = document.getElementById('leechWord');
  const meaningEl = document.getElementById('leechMeaning');
  const errorEl = document.getElementById('leechErrorMsg');
  errorEl.textContent = '';
  const word = wordEl.value.trim();
  const meaning = meaningEl.value.trim();
  if(!word){ errorEl.textContent = '単語を入力してください。'; return; }
  leechWords.push({
    id: genId('w_'), word, meaning, stepIndex: 0,
    nextReviewDate: nextDateForStep(0), missCount: 0, status: 'active'
  });
  await saveLeech();
  renderLeech();
  wordEl.value = ''; meaningEl.value = ''; wordEl.focus();
}

async function handleLeechCorrect(id){
  const entry = leechWords.find(w => w.id === id);
  if(!entry) return;
  const newStep = entry.stepIndex + 1;
  if(newStep >= DEFAULT_INTERVALS.length){
    entry.status = 'graduated';
    entry.gradDate = todayISO();
    entry.stepIndex = newStep;
  }else{
    entry.stepIndex = newStep;
    entry.nextReviewDate = nextDateForStep(newStep);
  }
  await saveLeech();
  renderLeech();
}

async function handleLeechWrong(id){
  const entry = leechWords.find(w => w.id === id);
  if(!entry) return;
  entry.missCount = (entry.missCount || 0) + 1;
  entry.stepIndex = 0;
  entry.nextReviewDate = nextDateForStep(0);
  await saveLeech();
  renderLeech();
}

async function handleLeechDelete(id){
  leechWords = leechWords.filter(w => w.id !== id);
  await saveLeech();
  renderLeech();
}

function renderLeech(){
  renderDueList();
  renderLeechManagement();
}

function renderDueList(){
  const dueList = document.getElementById('dueList');
  if(!dueList) return;

  const todayIso = todayISO();
  const active = leechWords.filter(w => w.status === 'active');
  const due = active.filter(w => w.nextReviewDate <= todayIso)
                     .sort((a,b) => a.nextReviewDate.localeCompare(b.nextReviewDate));

  if(due.length === 0){
    dueList.innerHTML = `<div class="empty-mini">今日レビューする単語はありません。</div>`;
  }else{
    dueList.innerHTML = due.map(w => {
      const overdue = w.nextReviewDate < todayIso;
      const warn = w.missCount >= LEECH_WARN_THRESHOLD
        ? `<span class="badge-warn">要注意：語源・対義語など別の覚え方を</span>` : '';
      return `
        <div class="due-item" data-id="${w.id}">
          <div class="word-row">
            <div><span class="word">${escapeHtml(w.word)}</span>${overdue ? '<span class="overdue">期限超過</span>' : ''}${warn}</div>
            <button class="reveal-btn" data-action="reveal" data-id="${w.id}">意味を確認</button>
          </div>
          <div class="meaning-text" data-role="meaning" data-id="${w.id}">${escapeHtml(w.meaning) || '（メモ未登録：口頭で確認）'}</div>
          <div class="word-actions" data-role="actions" data-id="${w.id}">
            <button class="btn-correct" data-action="correct" data-id="${w.id}">できた</button>
            <button class="btn-wrong" data-action="wrong" data-id="${w.id}">もう一度</button>
          </div>
        </div>`;
    }).join('');

    dueList.querySelectorAll('[data-action="reveal"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        dueList.querySelector(`[data-role="meaning"][data-id="${id}"]`).classList.add('shown');
        dueList.querySelector(`[data-role="actions"][data-id="${id}"]`).classList.add('shown');
      });
    });
    dueList.querySelectorAll('[data-action="correct"]').forEach(btn => {
      btn.addEventListener('click', () => handleLeechCorrect(btn.dataset.id));
    });
    dueList.querySelectorAll('[data-action="wrong"]').forEach(btn => {
      btn.addEventListener('click', () => handleLeechWrong(btn.dataset.id));
    });
  }
}

function renderLeechManagement(){
  const activeSummary  = document.getElementById('activeSummary');
  const activeTable    = document.getElementById('activeTable');
  const graduatedSummary = document.getElementById('graduatedSummary');
  const gradTable      = document.getElementById('graduatedTable');
  if(!activeSummary || !activeTable || !graduatedSummary || !gradTable) return;

  const active = leechWords.filter(w => w.status === 'active');
  const graduated = leechWords.filter(w => w.status === 'graduated');

  const activeSorted = active.slice().sort((a,b) => a.nextReviewDate.localeCompare(b.nextReviewDate));
  activeSummary.textContent = `登録中の苦手単語（${activeSorted.length}）`;
  if(activeSorted.length === 0){
    activeTable.innerHTML = `<tr><td class="empty-mini">まだ登録されていません。</td></tr>`;
  }else{
    activeTable.innerHTML = `
      <tr><th>単語</th><th>次回レビュー</th><th>ミス回数</th><th></th></tr>
      ${activeSorted.map(w => `
      <tr>
       <td>
        ${escapeHtml(w.word)}
        ${w.missCount >= LEECH_WARN_THRESHOLD ? '<span class="badge-warn">要注意</span>' : ''}
       </td>
       <td>${w.nextReviewDate}</td>
       <td>${w.missCount}</td>
       <td><button class="mini-del" data-id="${w.id}">削除</button></td>
      </tr>`).join('')}
    `;
    activeTable.querySelectorAll('.mini-del').forEach(btn => {
      btn.addEventListener('click', () => handleLeechDelete(btn.dataset.id));
    });
  }

  graduatedSummary.textContent = `卒業した単語（${graduated.length}）`;
  if(graduated.length === 0){
    gradTable.innerHTML = `<tr><td class="empty-mini">まだありません。</td></tr>`;
  }else{
    gradTable.innerHTML = `
      <tr><th>単語</th><th>卒業日</th><th></th></tr>
      ${graduated.map(w => `
        <tr>
          <td>${escapeHtml(w.word)}</td>
          <td>${w.gradDate || '-'}</td>
          <td><button class="mini-del" data-id="${w.id}">削除</button></td>
        </tr>`).join('')}
    `;
    gradTable.querySelectorAll('.mini-del').forEach(btn => {
      btn.addEventListener('click', () => handleLeechDelete(btn.dataset.id));
    });
  }
}

/* ---------- 成績・弱点分析 ---------- */

/* ───────── 成績の入力・グラフ ／ 単語テスト ───────── */
async function loadScores(){
  scoreRecords = loadFromStorage(SCORE_KEY);
}
async function saveScores(){
  saveToStorage(SCORE_KEY, scoreRecords);
}

function renderScoreList(){
  const listEl = document.getElementById('scoreEntryList');
  if(!listEl) return;
  if(scoreRecords.length === 0){
    listEl.innerHTML = '<div class="empty-mini">まだ成績データが登録されていません。</div>';
  } else {
    const sorted = [...scoreRecords].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    listEl.innerHTML = sorted.map(r => {
      const pct = r.total ? Math.round((r.score / r.total) * 100) : 0;
      const examBadge = r.examType
        ? `<span class="exam-type-badge">📋 ${escapeHtml(r.examType)}</span> `
        : '';
      const devBadge = (r.deviation != null && r.deviation !== '')
        ? `<span class="hensachi-badge"><span class="hb-label">偏差値</span>${escapeHtml(String(r.deviation))}</span> `
        : '';
      return `<div class="score-entry-item">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-bottom:4px;">
            ${examBadge}${devBadge}
          </div>
          <span class="rng">${escapeHtml(r.subject || '教科未設定')}${r.category ? ' / ' + escapeHtml(r.category) : ''}</span>
          <div class="meta">${escapeHtml(r.date || '')} ・ ${r.score}/${r.total}点（${pct}%）${r.note ? ' ・ ' + escapeHtml(r.note) : ''}</div>
        </div>
        <button class="del-btn" onclick="handleScoreDelete('${r.id}')">削除</button>
      </div>`;
    }).join('');
  }
  renderScoreChart();
}

// 試験種別ドロップダウンの変更処理
function handleExamTypeChange(selectEl) {
  const customInput = document.getElementById('scoreExamTypeCustom');
  if (selectEl.value === 'custom') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
  }
}

// 現在選択されている試験種別名を返す
function getSelectedExamType() {
  const sel = document.getElementById('scoreExamType');
  if (!sel) return '';
  if (sel.value === 'custom') {
    return document.getElementById('scoreExamTypeCustom').value.trim();
  }
  return sel.value;
}

async function handleScoreAdd(){
  const subjectEl = document.getElementById('scoreSubject');
  const categoryEl = document.getElementById('scoreCategory');
  const valueEl = document.getElementById('scoreValue');
  const totalEl = document.getElementById('scoreTotal');
  const deviationEl = document.getElementById('scoreDeviation');
  const dateEl = document.getElementById('scoreDate');
  const noteEl = document.getElementById('scoreNote');
  const errorEl = document.getElementById('scoreErrorMsg');
  const showError = (msg) => { if (errorEl) errorEl.textContent = msg; else alert(msg); };
  if (errorEl) errorEl.textContent = '';

  const subject = subjectEl.value.trim();
  const score = Number(valueEl.value);
  if(totalEl.value === '' || isNaN(Number(totalEl.value)) || Number(totalEl.value) <= 0){
    showError('満点を正しく入力してください。'); return;
  }
  const total = Number(totalEl.value);
  const examType = getSelectedExamType();
  const deviationRaw = deviationEl.value.trim();
  const deviation = deviationRaw !== '' ? Number(deviationRaw) : null;

  if(!subject){ showError('教科を入力してください。'); return; }
  if(valueEl.value === '' || isNaN(score) || score < 0){ showError('得点を正しく入力してください。'); return; }
  if(score > total){ showError('得点は満点以下で入力してください。'); return; }
  if(deviation !== null && (isNaN(deviation) || deviation < 0 || deviation > 100)){
    showError('偏差値は0〜100の数値で入力してください（省略可）。'); return;
  }

  scoreRecords.push({
    id: genId('s_'),
    subject,
    category: categoryEl.value.trim(),
    examType: examType || '',
    score, total,
    deviation,
    note: noteEl.value.trim(),
    date: dateEl.value || todayISO()
  });
  await saveScores();
  renderScoreList();

  // 入力欄をリセット（試験種別・教科・偏差値等）
  document.getElementById('scoreExamType').value = '';
  document.getElementById('scoreExamTypeCustom').style.display = 'none';
  document.getElementById('scoreExamTypeCustom').value = '';
  subjectEl.value = ''; categoryEl.value = ''; valueEl.value = '';
  totalEl.value = '100'; deviationEl.value = ''; noteEl.value = '';
  dateEl.value = todayISO();
  subjectEl.focus();
}

async function handleScoreDelete(id){
  scoreRecords = scoreRecords.filter(r => r.id !== id);
  await saveScores();
  renderScoreList();
}

function renderScoreChart(){
  const wrap = document.getElementById('scoreChartWrap');
  if(!wrap) return;
  if(typeof Chart === 'undefined' || scoreRecords.length === 0){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  /* ── ① 教科別 平均正答率チャート ── */
  const bySubject = {};
  scoreRecords.forEach(r => {
    const pct = r.total ? (r.score / r.total) * 100 : 0;
    if(!bySubject[r.subject]) bySubject[r.subject] = [];
    bySubject[r.subject].push(pct);
  });
  const labels = Object.keys(bySubject);
  const data = labels.map(k => Math.round(bySubject[k].reduce((a,b) => a+b, 0) / bySubject[k].length));

  const ctx = document.getElementById('scoreChart');
  if(scoreChartInstance) scoreChartInstance.destroy();
  scoreChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: '平均正答率(%)', data, backgroundColor: COLORS.gold }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min:0, max:100, grid:{ color: COLORS.grid } },
        x: { grid:{ display:false }, ticks:{ maxRotation:30, font:{ size:11 } } }
      },
      plugins: { legend:{ display:false } }
    }
  });

  /* ── ② 偏差値推移チャート（偏差値データがある場合のみ表示） ── */
  const devBox = document.getElementById('deviationChartBox');
  const devWithData = scoreRecords
    .filter(r => r.deviation != null && r.deviation !== '' && !isNaN(Number(r.deviation)))
    .sort((a,b) => (a.date||'').localeCompare(b.date||''))
    .slice(-10); // 直近10件

  if (!devBox) return;

  if (devWithData.length < 1) {
    devBox.style.display = 'none';
    if (deviationChartInstance) { deviationChartInstance.destroy(); deviationChartInstance = null; }
    return;
  }
  devBox.style.display = 'block';

  const devLabels = devWithData.map(r => {
    const subj = (r.subject || '').slice(0, 4);
    const exam = r.examType ? r.examType.replace(/模試|テスト|本番/g, '').slice(0,5) : '';
    return exam ? `${subj}\n${exam}` : subj;
  });
  const devData = devWithData.map(r => Number(r.deviation));

  // 偏差値帯の色分け
  const devColors = devData.map(v =>
    v >= 65 ? '#065f46' : v >= 55 ? COLORS.gold : v >= 45 ? COLORS.ink : COLORS.red
  );

  const devCtx = document.getElementById('deviationChart');
  if(deviationChartInstance) deviationChartInstance.destroy();
  deviationChartInstance = new Chart(devCtx, {
    type: 'bar',
    data: {
      labels: devLabels,
      datasets: [{
        label: '偏差値',
        data: devData,
        backgroundColor: devColors,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: {
          min: Math.max(0, Math.min(...devData) - 10),
          max: Math.min(100, Math.max(...devData) + 10),
          grid: { color: COLORS.grid },
          ticks: { font: { size: 11 } }
        },
        x: { grid:{ display:false }, ticks:{ maxRotation:35, font:{ size:10 } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx2 => {
              const r = devWithData[ctx2.dataIndex];
              const exam = r.examType ? ` (${r.examType})` : '';
              return `偏差値 ${ctx2.raw}${exam}`;
            }
          }
        },
        annotation: {
          annotations: {
            line50: {
              type: 'line', yMin: 50, yMax: 50,
              borderColor: 'rgba(180,180,180,0.6)', borderWidth: 1, borderDash: [4,4],
            }
          }
        }
      }
    }
  });
}

// [ai-features.html] parseJsonFromText / fileToGenerativePart / handleScoreImageFile /
//                    runWeaknessAnalysis / renderAnalysisResult → ai-features.html に移動

/* ---------- Test Mode Logic ---------- */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let testQueue = [];
let currentTestIdx = 0;
let testSessionResults = [];
let testAnswering = false; // 回答処理中フラグ（連打で同じ単語が2回採点され、次の単語が飛ばされるのを防ぐ）

document.getElementById('startTestBtn')?.addEventListener('click', () => {
  const mode = document.getElementById('testMode').value;
  const activeWords = leechWords.filter(w => w.status === 'active');
  if(activeWords.length === 0) { alert('現在、テストできる単語が登録されていません。'); return; }

  if(mode === 'all') {
    testQueue = [...activeWords];
  } else if(mode === 'warn') {
    testQueue = activeWords.filter(w => w.missCount >= LEECH_WARN_THRESHOLD);
    if(testQueue.length === 0) { alert('現在、要注意の単語はありません。'); return; }
  } else if(mode === 'random10') {
    testQueue = shuffle(activeWords).slice(0, 10);
  } else if(mode === 'miss1') {
    testQueue = activeWords.filter(w => w.missCount === 1);
    if(testQueue.length === 0) { alert('現在、ミス1回の単語はありません。'); return; }
  } else {
    // 【修正】未知のモードのとき、前回の testQueue が残って意図しない出題になっていた
    testQueue = [...activeWords];
  }

  currentTestIdx = 0;
  testSessionResults = [];
  testAnswering = false;
  document.getElementById('testArea').style.display = 'block';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('testModal').classList.add('active');
  showTestWord();
});

function showTestWord() {
  if(currentTestIdx >= testQueue.length) { finishTest(); return; }
  const wordData = testQueue[currentTestIdx];
  const meaningEl = document.getElementById('testMeaningDisplay');
  document.getElementById('testProgress').textContent = `問題 ${currentTestIdx + 1} / ${testQueue.length}`;
  document.getElementById('testWordDisplay').textContent = wordData.word;
  meaningEl.textContent = wordData.meaning || '（メモ未登録：口頭で確認）';
  meaningEl.classList.remove('shown');
  document.getElementById('testActions').classList.remove('shown');
  document.getElementById('testRevealBtn').style.display = 'block';
}

document.getElementById('testRevealBtn')?.addEventListener('click', () => {
  document.getElementById('testRevealBtn').style.display = 'none';
  document.getElementById('testMeaningDisplay').classList.add('shown');
  document.getElementById('testActions').classList.add('shown');
});

// 【修正】「できた」「もう一度」の共通処理。
//   以前は保存（await）の最中に連打すると同じ単語が二重に採点（復習ステップが2段進む）され、
//   currentTestIdx も2つ進んで次の単語が飛ばされていた。
async function answerTestWord(correct) {
  if (testAnswering) return;
  const wordData = testQueue[currentTestIdx];
  if (!wordData) return;
  testAnswering = true;
  try {
    testSessionResults.push({ word: wordData.word, correct });
    if (correct) await handleLeechCorrect(wordData.id);
    else await handleLeechWrong(wordData.id);
    currentTestIdx++;
    showTestWord();
  } finally {
    testAnswering = false;
  }
}

document.getElementById('testCorrectBtn')?.addEventListener('click', () => answerTestWord(true));
document.getElementById('testWrongBtn')?.addEventListener('click', () => answerTestWord(false));

function finishTest() {
  document.getElementById('testArea').style.display = 'none';
  document.getElementById('resultArea').style.display = 'block';
  const correctCount = testSessionResults.filter(r => r.correct).length;
  const rate = testQueue.length > 0 ? Math.round((correctCount / testQueue.length) * 100) : 0;
  document.getElementById('resultScore').textContent = `正答率: ${correctCount} / ${testQueue.length} (${rate}%)`;
  document.getElementById('resultList').innerHTML = testSessionResults.map(r => `
    <div class="result-item">
      <span style="font-family:'IBM Plex Mono', monospace; font-weight:700;">${escapeHtml(r.word)}</span>
      <span style="color:${r.correct ? 'var(--success)' : 'var(--margin-red)'}; font-weight:700;">
        ${r.correct ? '〇 できた' : '✖ もう一度'}
      </span>
    </div>
  `).join('');
}

// モーダルを閉じる処理
document.getElementById('closeTestBtn')?.addEventListener('click', () => {
  document.getElementById('testModal').classList.remove('active');
  renderLeech();
});
