const STORAGE_KEY = 'vocab-plan-entries';
const LEECH_KEY = 'vocab-leech-words';
const SCORE_KEY = 'vocab-score-records';
const ANALYSIS_KEY = 'vocab-weakness-analysis';
const DAILY_PROGRESS_KEY = 'vocab-daily-progress'; // 日別進捗記録
const WEEKDAYS = ['日','月','火','水','木','金','土'];
const DEFAULT_WEEKDAYS = [1,2,3,4,5,6];
const DEFAULT_INTERVALS = [1,3,7,14];
const LEECH_INTERVALS = [1,3,7,14];
const LEECH_WARN_THRESHOLD = 2;
const COLORS = { ink:'#1E2A44', gold:'#a97c1f', red:'#B23A2E', success:'#3a6b4c', grid:'#CBD5E3' };
/* ---------- 参考書用の変数 ---------- */
const REF_STORAGE_KEY = 'vocab-reference-entries';
/* ---------- 復習の完了チェック用 ---------- */
const REVIEW_DONE_KEY = 'vocab-review-done';


let entries = [];
let leechWords = [];
let scoreRecords = [];
let scoreChartInstance = null;
let deviationChartInstance = null;
let refEntries = []; // 参考書の予定を保存する配列
let reviewDoneSet = new Set(); // クリア済みの復習項目キーの集合
let dailyProgress = [];

// ── 復習インターバルの階層スタイルを返すヘルパー ──────────────
function getIntervalTier(interval) {
  if (interval <= 1) return 1;
  if (interval <= 3) return 2;
  if (interval <= 7) return 3;
  return 4;
}
function getIntervalTierStyle(interval) {
  const t = getIntervalTier(interval);
  return [
    null,
    { bg:'#dbeafe', color:'#1e40af', border:'#93c5fd', label:'Lv.1 初期',  labelShort:'Lv.1' },
    { bg:'#d1fae5', color:'#065f46', border:'#6ee7b7', label:'Lv.2 定着',  labelShort:'Lv.2' },
    { bg:'#fef3c7', color:'#92400e', border:'#fcd34d', label:'Lv.3 強化',  labelShort:'Lv.3' },
    { bg:'#fee2e2', color:'#991b1b', border:'#fca5a5', label:'Lv.4 仕上げ', labelShort:'Lv.4' },
  ][t];
}
function reviewLegendHTML() {
  return `<div class="review-legend">
    <span class="review-legend-label">🎯 復習ステップ：</span>
    <span class="review-legend-badge tag-review-t1">Lv.1 初期 <small>1日後</small></span>
    <span class="review-legend-badge tag-review-t2">Lv.2 定着 <small>3日後</small></span>
    <span class="review-legend-badge tag-review-t3">Lv.3 強化 <small>7日後</small></span>
    <span class="review-legend-badge tag-review-t4">Lv.4 仕上げ <small>14日後〜</small></span>
    <span style="color:var(--ink-soft); margin-left:4px; font-size:.68rem;">数字が大きいほど記憶定着の山場です</span>
  </div>`;
}

// ── STEP 8：統一バッジ生成ヘルパー ────────────────────────────

function buildCarryBadgeHtml(originalDate, cls = 'carry-badge') {
  const datePart = originalDate ? ` [${originalDate}]` : '';
  return `<span class="${cls}" style="background:#fff7ed;color:#9a3412;border-color:#fed7aa;">⚠️ 未完了繰越${datePart}</span>`;
}

function buildReviewBadgeHtml(interval, delayedDays, layout = 'inline') {
  const tier = getIntervalTier(interval);
  const ts = getIntervalTierStyle(interval);
  const mainBadge = `<span style="display:inline-flex;align-items:center;gap:3px;background:${ts.bg};color:${ts.color};border:1px solid ${ts.border};border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;white-space:nowrap;">🔁 復習 Lv.${tier} [${interval}日後]</span>`;
  const delayBadge = delayedDays > 0
    ? `<span style="display:inline-flex;align-items:center;background:#b23a2e;color:#fff;border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;white-space:nowrap;">🔄 [遅れ${delayedDays}日]</span>`
    : '';
  return `${mainBadge}${delayBadge ? ' ' + delayBadge : ''}`;
}

function pad(n){ return String(n).padStart(2,'0'); }
function formatISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function parseISO(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function addDays(d, n){ const nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; }
function todayISO(){ return formatISO(new Date()); }

function findNextReviewWeekday(fromDate, intervalDays, reviewWeekdays) {
  const base = addDays(parseISO(fromDate), intervalDays);
  if (!reviewWeekdays || reviewWeekdays.length === 0) {
    return formatISO(base);
  }
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(base, i);
    if (reviewWeekdays.includes(candidate.getDay())) {
      return formatISO(candidate);
    }
  }
  return formatISO(base);
}

function buildReviewKey(prefix, ownerId, rangeStart, rangeEnd, interval){
  return `${prefix}_${ownerId}_${rangeStart}_${rangeEnd}_${interval}`;
}

function loadReviewDone(){
  try{
    const raw = localStorage.getItem(REVIEW_DONE_KEY);
    reviewDoneSet = raw ? new Set(JSON.parse(raw)) : new Set();
  }catch(e){ reviewDoneSet = new Set(); }
}
function saveReviewDone(){
  try{
    localStorage.setItem(REVIEW_DONE_KEY, JSON.stringify(Array.from(reviewDoneSet)));
  }catch(e){ console.error('Storage error:', e); }
}

function computeEffectiveReviewDate(originalIso, key, reviewWeekdays){
  if(reviewDoneSet.has(key)){
    return { date: originalIso, delayedDays: 0, done: true };
  }
  const todayIso  = todayISO();
  const diffDays  = Math.round(
    (parseISO(todayIso) - parseISO(originalIso)) / 86400000
  );
  if(diffDays <= 0){
    return { date: originalIso, delayedDays: 0, done: false };
  }

  const newDate = reviewWeekdays && reviewWeekdays.length > 0
    ? findNextReviewWeekday(originalIso, diffDays, reviewWeekdays)
    : todayIso;

  const movedKey = `${key}_moved_${newDate}`;

  return { date: newDate, movedKey, delayedDays: diffDays, done: false };
}

function buildAllReviews(){
  const vocabChunks = entries.flatMap(computeAdjustedChunksForEntry);
  const vocabReviews = [];
  vocabChunks.forEach(c => {
    const hasProgressRecord = dailyProgress.some(p =>
      p.type === 'word' && (p.originEntryId === c.entryId || p.entryId === c.entryId) && p.date === c.date
    );
    if (hasProgressRecord) return;
    (c.intervals || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(c.date), n));
      const key = buildReviewKey('w', c.entryId, c.rangeStart, c.rangeEnd, n);
      const entryForChunk = entries.find(e => e.id === c.entryId);
      const reviewWeekdays = entryForChunk?.reviewWeekdays || [];
      const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
      vocabReviews.push({
        date: eff.date, originalDate, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd,
        interval: n, key: eff.movedKey || key, delayedDays: eff.delayedDays, done: eff.done
      });
    });
  });

  dailyProgress
    .filter(p => p.type === 'word' && !p.notProgressed)
    .forEach(p => {
      const targetId = p.originEntryId || p.entryId;
      const entry = entries.find(e => e.id === targetId || p.entryId.startsWith(e.id + '_'));
      if (!entry) return;
      const reviewWeekdays = entry.reviewWeekdays || [];
      DEFAULT_INTERVALS.forEach(n => {
        const originalDate = findNextReviewWeekday(p.date, n, reviewWeekdays);
        const key = `w_prog_${entry.id}_${p.date}_${p.plannedStart}_${n}`;
        const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
        vocabReviews.push({
          date: eff.date, originalDate,
          rangeStart: p.plannedStart, rangeEnd: p.actualEnd,
          interval: n, key: eff.movedKey || key, entryId: entry.id,
          delayedDays: eff.delayedDays, done: eff.done
        });
      });
    });

  const refChunks = refEntries.flatMap(plan =>
    computeAdjustedRefSchedule(plan).map(c => ({ ...c, bookName: plan.bookName, planId: plan.id }))
  );

  const refReviews = [];
  dailyProgress
    .filter(p => p.type === 'book' && !p.notProgressed)
    .forEach(p => {
      const resolvedPlanId = p.planId || p.entryId;
      const plan = refEntries.find(r => r.id === resolvedPlanId || p.entryId.startsWith(r.id + '_'));
      if (!plan) return;
      const reviewWeekdays = plan.reviewWeekdays || [];
      const actualStart = p.plannedStart;
      const actualEnd   = p.actualEnd;
      DEFAULT_INTERVALS.forEach(n => {
        const originalDate = findNextReviewWeekday(p.date, n, reviewWeekdays);
        const key = `r_prog_${plan.id}_${p.date}_${actualStart}_${n}`;
        const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
        refReviews.push({
          date: eff.date, originalDate,
          rangeStart: actualStart, rangeEnd: actualEnd,
          interval: n, bookName: plan.bookName,
          planId: plan.id, key: eff.movedKey || key,
          delayedDays: eff.delayedDays, done: eff.done
        });
      });
    });

  return { vocabChunks, refChunks, vocabReviews, refReviews };
}

function getCarryForwardChunks(vocabChunks, refChunks) {
  const todayStr = todayISO();

  const cfVocab = vocabChunks
    .filter(chunk => chunk.date < todayStr)
    .filter(chunk => {
      const latest = getLatestProgress(chunk.entryId, 'word');
      if (latest && latest.actualEnd >= chunk.rangeEnd) return false;
      const hasRecord = dailyProgress.some(p =>
        p.date === chunk.date && p.type === 'word' &&
        ((p.originEntryId || p.entryId) === chunk.entryId || p.entryId.startsWith(chunk.entryId + '_'))
      );
      return !hasRecord;
    })
    .map(chunk => ({ ...chunk, date: todayStr, carriedForward: true, originalDate: chunk.date }));

  const cfRef = refChunks
    .filter(chunk => chunk.date < todayStr)
    .filter(chunk => {
      const latest = getLatestProgress(chunk.planId, 'book');
      if (latest && latest.actualEnd >= chunk.rangeEnd) return false;
      const hasRecord = dailyProgress.some(p => {
        if (p.type !== 'book' || p.date !== chunk.date) return false;
        const resolvedPlanId = p.planId || p.entryId;
        return resolvedPlanId === chunk.planId || p.entryId.startsWith(chunk.planId + '_');
      });
      return !hasRecord;
    })
    .map(chunk => ({ ...chunk, date: todayStr, carriedForward: true, originalDate: chunk.date }));

  return { cfVocab, cfRef };
}

function isReviewFromOriginalSchedule(review, cfChunk, type) {
  const ownerId = type === 'word' ? cfChunk.entryId : cfChunk.planId;
  const prefix = type === 'word' ? 'w' : 'r';
  const expectedKey = buildReviewKey(prefix, ownerId, cfChunk.rangeStart, cfChunk.rangeEnd, review.interval);
  if (review.key !== expectedKey) return false;
  const expectedOriginal = formatISO(addDays(parseISO(cfChunk.originalDate), review.interval));
  return review.originalDate === expectedOriginal;
}

function adjustReviewsForCarryForward(vocabReviews, refReviews, cfVocab, cfRef) {
  const filteredVocabReviews = vocabReviews.filter(r =>
    !cfVocab.some(cf => isReviewFromOriginalSchedule(r, cf, 'word'))
  );
  const filteredRefReviews = refReviews;

  cfVocab.forEach(c => {
    (c.intervals || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(c.date), n));
      const key = buildReviewKey('w', c.entryId, c.rangeStart, c.rangeEnd, n);
      const entryForCf = entries.find(e => e.id === c.entryId);
      const reviewWeekdays = entryForCf?.reviewWeekdays || [];
      const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
      filteredVocabReviews.push({
        date: eff.date, originalDate, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd,
        interval: n, key: eff.movedKey || key, delayedDays: eff.delayedDays, done: eff.done
      });
    });
  });

  return { vocabReviews: filteredVocabReviews, refReviews: filteredRefReviews };
}

function buildScheduleData() {
  const { vocabChunks: rawVocabChunks, refChunks: rawRefChunks, vocabReviews, refReviews } = buildAllReviews();
  const { cfVocab, cfRef } = getCarryForwardChunks(rawVocabChunks, rawRefChunks);
  const adjusted = adjustReviewsForCarryForward(vocabReviews, refReviews, cfVocab, cfRef);
  return {
    rawVocabChunks,
    rawRefChunks,
    vocabChunks: [...rawVocabChunks, ...cfVocab],
    refChunks: [...rawRefChunks, ...cfRef],
    cfVocab,
    cfRef,
    vocabReviews: adjusted.vocabReviews,
    refReviews: adjusted.refReviews
  };
}

function attachReviewCheckHandlers(container){
  if(!container) return;
  container.querySelectorAll('.review-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      if(cb.checked){ reviewDoneSet.add(key); } else { reviewDoneSet.delete(key); }
      saveReviewDone();
      refreshAllSchedules();
      renderIntegratedSchedule();
      renderRefTodayCard();
    });
  });
}

/* ---------- 日別進捗（保存・読み込み） ---------- */
function loadDailyProgress() {
  try {
    const raw = localStorage.getItem(DAILY_PROGRESS_KEY);
    dailyProgress = raw ? JSON.parse(raw) : [];
  } catch(e) { dailyProgress = []; }
}
function saveDailyProgress() {
  try {
    localStorage.setItem(DAILY_PROGRESS_KEY, JSON.stringify(dailyProgress));
  } catch(e) { console.error('Storage error:', e); }
}

/**
 * 特定エントリの最新進捗レコードを取得（キー照合強化）
 */
function getLatestProgress(entryId, type) {
  const records = dailyProgress
    .filter(p => {
      if (p.type !== type) return false;
      if (type === 'book') {
        const resolvedPlanId = p.planId || p.entryId;
        return resolvedPlanId === entryId || p.entryId === entryId || (p.entryId && p.entryId.startsWith(entryId + '_'));
      }
      return (p.originEntryId || p.entryId) === entryId || (p.entryId && p.entryId.startsWith(entryId + '_'));
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return records[0] || null;
}

/**
 * 進捗記録を考慮してチャンクを再計算する（単語用）
 */
function computeAdjustedChunksForEntry(entry) {
  const latest = getLatestProgress(entry.id, 'word');
  if (!latest) return computeChunksForEntry(entry);

  const originalChunks = computeChunksForEntry(entry);
  const pastChunks = originalChunks.filter(c => c.date <= latest.date);
  const futureChunks = originalChunks.filter(c => c.date > latest.date);

  const actualEnd = latest.actualEnd;
  const totalEnd  = entry.endNum;

  // 今日のチャンクの rangeEnd を実際の進捗結果に更新
  const updatedPast = pastChunks.map(c => c.date === latest.date ? { ...c, rangeEnd: Math.min(actualEnd, entry.endNum) } : c);

  if (actualEnd >= totalEnd) return updatedPast;

  const remaining = totalEnd - actualEnd;

  if (futureChunks.length === 0) {
    const nextDate = findNextStudyDay(latest.date, entry.weekdays);
    return [
      ...updatedPast,
      {
        date: nextDate,
        rangeStart: actualEnd + 1,
        rangeEnd: totalEnd,
        entryId: entry.id,
        intervals: entry.intervals,
        isCarriedNew: true
      }
    ];
  }

  const base = Math.floor(remaining / futureChunks.length);
  const rem  = remaining % futureChunks.length;
  let cursor = actualEnd + 1;

  const newFutureChunks = futureChunks.map((c, idx) => {
    const count = base + (idx < rem ? 1 : 0);
    const rangeStart = cursor;
    const rangeEnd   = cursor + count - 1;
    cursor = rangeEnd + 1;
    return { ...c, rangeStart, rangeEnd, isAdjusted: true,
             isCarriedNew: idx === 0 };
  });

  return [...updatedPast, ...newFutureChunks];
}

function findNextStudyDay(fromDate, weekdays) {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(parseISO(fromDate), i);
    if (weekdays.includes(d.getDay())) return formatISO(d);
  }
  return formatISO(addDays(parseISO(fromDate), 1));
}

/**
 * 進捗記録を考慮してチャンクを再計算する（参考書用）
 */
function computeAdjustedRefSchedule(plan) {
  const latest = getLatestProgress(plan.id, 'book');
  if (!latest) return computeRefSchedule(plan);

  const originalChunks = computeRefSchedule(plan);
  const pastChunks = originalChunks.filter(c => c.date <= latest.date);
  const futureChunks = originalChunks.filter(c => c.date > latest.date);

  const actualEnd = latest.actualEnd;
  const totalEnd = plan.endNum;

  // 今日のチャンクの rangeEnd を実際の進捗結果に更新
  const updatedPast = pastChunks.map(c => c.date === latest.date ? { ...c, rangeEnd: Math.min(actualEnd, plan.endNum) } : c);

  if (actualEnd >= totalEnd) return updatedPast;

  // 修正箇所：将来チャンクがない場合も次の学習日に残りのページを再割り当て
  if (futureChunks.length === 0) {
    const nextDate = findNextStudyDay(latest.date, plan.weekdays || DEFAULT_WEEKDAYS);
    return [
      ...updatedPast,
      {
        date: nextDate,
        rangeStart: actualEnd + 1,
        rangeEnd: totalEnd,
        planId: plan.id,
        bookName: plan.bookName,
        isCarriedNew: true
      }
    ];
  }

  const remaining = totalEnd - actualEnd;
  const base = Math.floor(remaining / futureChunks.length);
  const rem = remaining % futureChunks.length;
  let cursor = actualEnd + 1;

  const newFutureChunks = futureChunks.map((c, idx) => {
    const count = base + (idx < rem ? 1 : 0);
    const rangeStart = cursor;
    const rangeEnd = cursor + count - 1;
    cursor = rangeEnd + 1;
    return { ...c, rangeStart, rangeEnd, isAdjusted: true,
             isCarriedNew: idx === 0 };
  });

  return [...updatedPast, ...newFutureChunks];
}

function computeEarlyDays(entry, type, actualEnd) {
  if (type === 'word') {
    if (actualEnd < entry.endNum) return 0;
    const originalChunks = computeChunksForEntry(entry);
    if (originalChunks.length === 0) return 0;
    const lastChunk = originalChunks[originalChunks.length - 1];
    const todayD = parseISO(todayISO());
    const lastD = parseISO(lastChunk.date);
    return Math.max(0, Math.round((lastD - todayD) / 86400000));
  } else {
    const plan = refEntries.find(p => p.id === entry.id);
    if (!plan || actualEnd < plan.endNum) return 0;
    const originalChunks = computeRefSchedule(plan);
    if (originalChunks.length === 0) return 0;
    const lastChunk = originalChunks[originalChunks.length - 1];
    const todayD = parseISO(todayISO());
    const lastD = parseISO(lastChunk.date);
    return Math.max(0, Math.round((lastD - todayD) / 86400000));
  }
}

/* ---------- weekly range entries (shared) ---------- */

function buildWeekdayChips(rowId = 'weekdayRow', defaultDays = DEFAULT_WEEKDAYS){
  const row = document.getElementById(rowId);
  if(!row) return;
  row.innerHTML = '';
  WEEKDAYS.forEach((label, idx) => {
    const chip = document.createElement('label');
    chip.className = 'chip' + (defaultDays.includes(idx) ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" value="${idx}" ${defaultDays.includes(idx)?'checked':''}> ${label}`;
    const cb = chip.querySelector('input');
    cb.addEventListener('change', () => chip.classList.toggle('checked', cb.checked));
    row.appendChild(chip);
  });
}

function buildIntervalChips(rowId = 'intervalRow', defaultIntervals = DEFAULT_INTERVALS){
  const row = document.getElementById(rowId);
  if(!row) return;
  row.innerHTML = '';
  [1,2,3,5,7,10,14,21].forEach(n => {
    const chip = document.createElement('label');
    const checked = defaultIntervals.includes(n);
    chip.className = 'chip' + (checked ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" value="${n}" ${checked?'checked':''}> ${n}日後`;
    const cb = chip.querySelector('input');
    cb.addEventListener('change', () => chip.classList.toggle('checked', cb.checked));
    row.appendChild(chip);
  });
}

function getCheckedValues(rowId){
  return Array.from(document.querySelectorAll(`#${rowId} input:checked`)).map(el => Number(el.value));
}

async function loadEntries(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    entries = raw ? JSON.parse(raw) : [];
  }catch(e){ entries = []; }
}
async function saveEntries(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }catch(e){ console.error('Storage error:', e); }
}

function computeChunksForEntry(entry){
  const start = parseISO(entry.startDate);
  const total = entry.endNum - entry.startNum + 1;
  const chunks = [];
  
  if (entry.planMode === 'byAmount') {
    let cursor = entry.startNum;
    let daysAdded = 0;
    while(cursor <= entry.endNum) {
      const d = addDays(start, daysAdded);
      if (entry.weekdays.includes(d.getDay())) {
        const count = Math.min(entry.amountPerDay, entry.endNum - cursor + 1);
        const rangeStart = cursor;
        const rangeEnd = cursor + count - 1;
        chunks.push({ date: formatISO(d), rangeStart, rangeEnd, entryId: entry.id, intervals: entry.intervals });
        cursor = rangeEnd + 1;
      }
      daysAdded++;
      if (daysAdded > 365) break;
    }
  } 
  else {
    const studyDates = [];
    const end = entry.endDate ? parseISO(entry.endDate) : addDays(start, 6);
    let cursorDate = new Date(start);
    while (cursorDate <= end) {
      if (entry.weekdays.includes(cursorDate.getDay())) {
        studyDates.push(new Date(cursorDate));
      }
      cursorDate.setDate(cursorDate.getDate() + 1);
    }
    
    if(studyDates.length === 0) return [];
    
    const days = studyDates.length;
    const base = Math.floor(total/days);
    const rem = total % days;
    let cursor = entry.startNum;
    
    studyDates.forEach((d, idx) => {
      const count = base + (idx < rem ? 1 : 0);
      if(count <= 0) return;
      const rangeStart = cursor;
      const rangeEnd = cursor + count - 1;
      chunks.push({ date: formatISO(d), rangeStart, rangeEnd, entryId: entry.id, intervals: entry.intervals });
      cursor = rangeEnd + 1;
    });
  }
  return chunks;
}

function renderEntryList(){
  const list = document.getElementById('entryList');
  list.innerHTML = '';
  if(entries.length === 0) return;
  entries.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'entry-item';
    const wdLabel = entry.weekdays.slice().sort((a,b)=>a-b).map(i=>WEEKDAYS[i]).join('・');
    
    let modeText = '';
    if (entry.planMode === 'byAmount') {
      modeText = `開始日 ${entry.startDate} (1日${entry.amountPerDay}単語)`;
    } else {
      modeText = entry.endDate ? `${entry.startDate} 〜 ${entry.endDate}` : `開始日 ${entry.startDate} (1週間)`;
    }

    item.innerHTML = `
      <div>
        <span class="rng">${entry.startNum}〜${entry.endNum}</span>
        <div class="meta">${modeText} ／ 学習日: ${wdLabel} ／ 復習: ${entry.intervals.join('・')}日後</div>
      </div>
      <button class="del-btn" data-id="${entry.id}">削除</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      entries = entries.filter(e => e.id !== btn.dataset.id);
      await saveEntries();
      renderAll();
    });
  });
}

function renderMergedSchedule(containerId){
  const area = document.getElementById(containerId);
  if(!area) return;

  const { vocabChunks, refChunks, vocabReviews, refReviews } = buildScheduleData();

  if(entries.length === 0 && refEntries.length === 0){
    area.innerHTML = `<div class="empty-state">まだ単語範囲・参考書が登録されていません。上のフォームから追加してください。</div>`;
    return;
  }
  if(vocabChunks.length === 0 && refChunks.length === 0){
    area.innerHTML = `<div class="empty-state">学習曜日が選択されていない範囲があります。設定を確認してください。</div>`;
    return;
  }

  const today = new Date(); today.setHours(0,0,0,0);
  let minDate = new Date(today);
  const futureDates = [
    ...vocabChunks.filter(c => parseISO(c.date) >= today).map(c => parseISO(c.date)),
    ...vocabReviews.filter(r => parseISO(r.date) >= today).map(r => parseISO(r.date)),
    ...refChunks.filter(c => parseISO(c.date) >= today).map(c => parseISO(c.date)),
    ...refReviews.filter(r => parseISO(r.date) >= today).map(r => parseISO(r.date)),
    today
  ];
  let maxDate = new Date(Math.max(...futureDates));
  const MAX_DAYS = 45;
  const spanDays = Math.round((maxDate - minDate) / 86400000) + 1;
  let truncated = false;
  if(spanDays > MAX_DAYS){ maxDate = addDays(minDate, MAX_DAYS - 1); truncated = true; }

  const rows = [];
  let cursor = new Date(minDate);
  while(cursor <= maxDate){
    const iso = formatISO(cursor);
    const newItems = vocabChunks.filter(c => c.date === iso);
    const reviewItems = vocabReviews.filter(r => r.date === iso);
    const refItems = refChunks.filter(c => c.date === iso);
    const refReviewItems = refReviews.filter(r => r.date === iso);
    if(newItems.length || reviewItems.length || refItems.length || refReviewItems.length){ rows.push({ date: new Date(cursor), iso, newItems, reviewItems, refItems, refReviewItems }); }
    cursor = addDays(cursor, 1);
  }

  const todayIso = todayISO();
  const INITIAL_VISIBLE_ROWS = 3;

  function rowHtml(row) {
    const isToday = row.iso === todayIso;
    const wd = WEEKDAYS[row.date.getDay()];
    const dateLabel = `${row.date.getMonth()+1}/${row.date.getDate()}`;
    return `<tr class="${isToday ? 'today' : ''}">
      <td class="date-cell">${dateLabel}<span class="wd">(${wd})</span>${isToday ? '<span class="today-badge">今日</span>' : ''}</td>
      <td>${row.newItems.map(c => {
        const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
        const cnBadge = c.isCarriedNew   ? buildCarryBadgeHtml(c.originalDate || null) : '';
        return `<span class="tag tag-new">${c.rangeStart}〜${c.rangeEnd}${cfBadge}${cnBadge}</span>`;
      }).join('') || '—'}</td>
      <td>${row.reviewItems.map(r => {
        const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
        return `<label class="tag tag-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}><span class="stamp">◎</span>${reviewBadge} ${r.rangeStart}〜${r.rangeEnd}</label>`;
      }).join('') || '—'}</td>
      <td>${row.refItems.map(c => {
        const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
        const cnBadge = c.isCarriedNew   ? buildCarryBadgeHtml(c.originalDate || null) : '';
        return `<span class="tag tag-ref">${escapeHtml(c.bookName)} ${c.rangeStart}〜${c.rangeEnd}${cfBadge}${cnBadge}</span>`;
      }).join('') || '—'}</td>
      <td>${row.refReviewItems.map(r => {
        const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
        return `<label class="tag tag-ref-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}><span class="stamp">◎</span>${reviewBadge} ${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}</label>`;
      }).join('') || '—'}</td>
    </tr>`;
  }

  const tableHead = `<thead><tr><th>日付</th><th>単語：新規</th><th>単語：復習</th><th>参考書：新規</th><th>参考書：復習</th></tr></thead>`;
  const visibleRows = rows.slice(0, INITIAL_VISIBLE_ROWS);
  const hiddenRows  = rows.slice(INITIAL_VISIBLE_ROWS);
  const detailsWasOpen = document.getElementById(`schedule-details-${containerId}`)?.open;

  let html = reviewLegendHTML();
  html += `<table>${tableHead}<tbody>`;
  visibleRows.forEach(row => { html += rowHtml(row); });
  html += `</tbody></table>`;

  if (hiddenRows.length > 0) {
    const openAttr = detailsWasOpen !== false ? ' open' : '';
    html += `<details class="schedule-details" id="schedule-details-${containerId}"${openAttr}>
      <summary>残りのスケジュール（${hiddenRows.length}日）</summary>
      <div class="schedule-details-body schedule-wrap">
        <table>${tableHead}<tbody>`;
    hiddenRows.forEach(row => { html += rowHtml(row); });
    html += `</tbody></table></div></details>`;
  }
  if(truncated){ html += `<div class="hint" style="margin-top:8px;">※表示は45日分までです。それ以降は範囲を追加していくと自動で延びます。</div>`; }
  html += `<div class="hint" style="margin-top:8px;">※過去日のスケジュールは非表示です。未達成の新規項目は「今日」に繰り上げられ、それに伴う復習日も自動で再計算されます。4日目以降は「残りのスケジュール」を開いて確認できます。復習はチェックを入れるとクリア済みになります。</div>`;
  area.innerHTML = html;
  attachReviewCheckHandlers(area);
}

function refreshAllSchedules(){
  renderMergedSchedule('scheduleArea');
}

function renderSchedule(){
  refreshAllSchedules();
}

function renderIntegratedSchedule() {
  const container = document.getElementById('integratedScheduleList');
  const wasFutureOpen = document.getElementById('integratedScheduleFuture')?.open;
  container.innerHTML = '';

  container.insertAdjacentHTML('beforeend', reviewLegendHTML());

  const periodMode = document.querySelector('input[name="schedulePeriod"]:checked').value;
  const targetDays = periodMode === 'week' ? 7 : 30;

  const {
    rawVocabChunks: rawWordChunks,
    rawRefChunks: rawBookChunks,
    vocabChunks: allWordChunks,
    refChunks: allBookChunks,
    vocabReviews: allWordReviews,
    refReviews: allBookReviews
  } = buildScheduleData();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const futureDetails = document.createElement('details');
  futureDetails.className = 'schedule-details';
  futureDetails.id = 'integratedScheduleFuture';
  if (wasFutureOpen !== undefined) {
    futureDetails.open = wasFutureOpen;
  } else {
    futureDetails.open = true;
  }

  const futureBody = document.createElement('div');
  futureBody.className = 'schedule-details-body';
  let futureDayCount = 0;

  function buildDayCard(i, currentLoopDate, dateStr) {
    const dayWords = allWordChunks.filter(chunk => chunk.date.startsWith(dateStr));
    const dayBooks = allBookChunks.filter(chunk => chunk.date.startsWith(dateStr));
    const dayWordReviews = allWordReviews.filter(r => r.date.startsWith(dateStr));
    const dayBookReviews = allBookReviews.filter(r => r.date.startsWith(dateStr));

    if (dayWords.length === 0 && dayBooks.length === 0 && dayWordReviews.length === 0 && dayBookReviews.length === 0 && periodMode === 'month') {
      return null;
    }

    const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][currentLoopDate.getDay()];
    const mm = String(currentLoopDate.getMonth() + 1).padStart(2, '0');
    const dd = String(currentLoopDate.getDate()).padStart(2, '0');

    const dayCard = document.createElement('div');
    dayCard.style.cssText = "background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); max-width: 100%; overflow: hidden; word-break: break-word;";

    let taskHtml = '';

    dayWords.forEach(w => {
      const carryBadge = w.carriedForward
        ? buildCarryBadgeHtml(w.originalDate)
        : (w.isCarriedNew ? buildCarryBadgeHtml(w.originalDate || null) : '');
      taskHtml += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"><span style="background:#e3f2fd;color:#0d47a1;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">単語</span>${carryBadge}<span style="color:#333;font-size:.85rem;">${w.rangeStart} 〜 ${w.rangeEnd}</span></div>`;
    });

    dayBooks.forEach(b => {
      const carryBadge = b.carriedForward
        ? buildCarryBadgeHtml(b.originalDate)
        : (b.isCarriedNew ? buildCarryBadgeHtml(b.originalDate || null) : '');
      taskHtml += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"><span style="background:#e8f5e9;color:#1b5e20;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">参考書</span>${carryBadge}<span style="color:#333;font-size:.85rem;">${escapeHtml(b.bookName)}: ${b.rangeStart} 〜 ${b.rangeEnd}</span></div>`;
    });

    dayWordReviews.forEach(r => {
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      taskHtml += `<div style="margin-top:6px;max-width:100%;overflow:hidden;"><label style="cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 9px;border-radius:6px;background:${ts.bg};border:1px solid ${ts.border};${r.done ? 'opacity:.5;text-decoration:line-through;' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''} style="margin:0;flex-shrink:0;">${reviewBadge}<span style="color:#333;font-size:.8rem;word-break:break-all;">単語 ${r.rangeStart}〜${r.rangeEnd}</span></label></div>`;
    });

    dayBookReviews.forEach(r => {
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      taskHtml += `<div style="margin-top:6px;max-width:100%;overflow:hidden;"><label style="cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 9px;border-radius:6px;background:${ts.bg};border:1px solid ${ts.border};${r.done ? 'opacity:.5;text-decoration:line-through;' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''} style="margin:0;flex-shrink:0;">${reviewBadge}<span style="color:#333;font-size:.8rem;word-break:break-all;">${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}</span></label></div>`;
    });

    if (taskHtml === '') {
      taskHtml = `<div style="color: #999; font-size: 0.85rem; margin-top: 4px;">予定なし</div>`;
    }

    let progressSectionHtml = '';
    if (i === 0) {
      const dayWordsForProgress = rawWordChunks.filter(c => c.date.startsWith(dateStr));
      const dayBooksForProgress = allBookChunks.filter(c => c.date.startsWith(dateStr));
      const dayWordReviewsForProgress = dayWordReviews.filter(r => !r.done);
      const dayBookReviewsForProgress = dayBookReviews.filter(r => !r.done);
      const hasAnyTask = dayWordsForProgress.length > 0 || dayBooksForProgress.length > 0
                      || dayWordReviewsForProgress.length > 0 || dayBookReviewsForProgress.length > 0;
      if (hasAnyTask) {
        const html = buildProgressInputSection(
          dateStr,
          dayWordsForProgress,
          dayBooksForProgress,
          dateStr,
          dayWordReviewsForProgress,
          dayBookReviewsForProgress
        );
        progressSectionHtml = html || '';
      }
    }

    const hasCFWords  = i === 0 && dayWords.some(w => w.carriedForward);
    const hasCFBooks  = i === 0 && dayBooks.some(b => b.carriedForward);
    const hasCNWords  = i === 0 && dayWords.some(w => w.isCarriedNew);
    const hasCNBooks  = i === 0 && dayBooks.some(b => b.isCarriedNew);
    const carryForwardBanner = (hasCFWords || hasCFBooks || hasCNWords || hasCNBooks)
      ? `<div style="margin-bottom:8px;padding:7px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;font-size:.78rem;color:#9a3412;font-weight:600;">
           ⚠️ 過去の未達成スケジュールが繰り越されています。
         </div>`
      : '';

    dayCard.innerHTML = `
      <div style="font-weight: bold; font-size: 0.9rem; color: #555; border-bottom: 1px dashed #eee; padding-bottom: 4px;">
        ${mm}/${dd} (${dayOfWeek})${i === 0 ? ' <span style="display:inline-block;font-size:.7rem;background:var(--ink);color:#fff;border-radius:4px;padding:1px 6px;margin-left:4px;">今日</span>' : ''}
      </div>
      <div style="padding-top: 4px;">${carryForwardBanner}${taskHtml}</div>
      ${progressSectionHtml}
    `;

    if (i === 0) {
      const dayWordsForProgress = rawWordChunks.filter(c => c.date.startsWith(dateStr));
      const dayBooksForProgress = allBookChunks.filter(c => c.date.startsWith(dateStr));
      const dayWordReviewsForProgress2 = dayWordReviews.filter(r => !r.done);
      const dayBookReviewsForProgress2 = dayBookReviews.filter(r => !r.done);
      if (dayWordsForProgress.length > 0 || dayBooksForProgress.length > 0
          || dayWordReviewsForProgress2.length > 0 || dayBookReviewsForProgress2.length > 0) {
        attachProgressInputHandlers(dayCard, dateStr);
      }
    }

    return dayCard;
  }

  for (let i = 0; i < targetDays; i++) {
    const currentLoopDate = new Date(today);
    currentLoopDate.setDate(today.getDate() + i);
    const yyyy = currentLoopDate.getFullYear();
    const mm = String(currentLoopDate.getMonth() + 1).padStart(2, '0');
    const dd = String(currentLoopDate.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const dayCard = buildDayCard(i, currentLoopDate, dateStr);
    if (!dayCard) continue;

    if (i === 0) {
      container.appendChild(dayCard);
    } else {
      futureBody.appendChild(dayCard);
      futureDayCount++;
    }
  }

  if (futureDayCount > 0) {
    const summary = document.createElement('summary');
    summary.id = 'futureScheduleSummary';
    summary.textContent = `今後のスケジュール（${futureDayCount}日）`;
    futureDetails.appendChild(summary);
    futureDetails.appendChild(futureBody);
    container.appendChild(futureDetails);
  }

  if (!container.querySelector('div:not(.review-legend)')) {
    container.innerHTML += '<div style="text-align:center; color:#999; padding:20px;">この期間のスケジュールはありません。設定タブから登録してください。</div>';
  }

  attachReviewCheckHandlers(container);
  updateTodaySummaryCard();
}

/* ---------- 今日のサマリーカード更新 ---------- */
function updateTodaySummaryCard() {
  const todayStr = todayISO();

  const dateEl = document.getElementById('todaySummaryDate');
  if (dateEl) {
    const d = new Date();
    const weekLabel = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    dateEl.textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${weekLabel}）`;
  }

  const {
    vocabChunks,
    refChunks,
    vocabReviews,
    refReviews
  } = buildScheduleData();

  const todayWords = vocabChunks.filter(c => c.date.startsWith(todayStr));
  let totalWords = 0;
  todayWords.forEach(w => { totalWords += w.rangeEnd - w.rangeStart + 1; });

  const todayBooks = refChunks.filter(c => c.date.startsWith(todayStr));
  let totalPages = 0;
  todayBooks.forEach(b => { totalPages += b.rangeEnd - b.rangeStart + 1; });

  const todayWordReviews = vocabReviews.filter(r => r.date.startsWith(todayStr) && !r.done);
  const todayBookReviews = refReviews.filter(r => r.date.startsWith(todayStr) && !r.done);
  const totalReviews = todayWordReviews.length + todayBookReviews.length;

  const wordsEl = document.getElementById('ts-words');
  const pagesEl = document.getElementById('ts-pages');
  const reviewsEl = document.getElementById('ts-reviews');
  const allDoneEl = document.getElementById('ts-all-done');

  const hasAnyTask = (todayWords.length > 0 || todayBooks.length > 0 || vocabReviews.filter(r => r.date.startsWith(todayStr)).length > 0 || refReviews.filter(r => r.date.startsWith(todayStr)).length > 0);

  if (wordsEl) wordsEl.innerHTML = totalWords > 0 ? `${totalWords}<span class="ts-unit">語</span>` : `—<span class="ts-unit">語</span>`;
  if (pagesEl) pagesEl.innerHTML = totalPages > 0 ? `${totalPages}<span class="ts-unit">ページ</span>` : `—<span class="ts-unit">ページ</span>`;
  if (reviewsEl) reviewsEl.innerHTML = `${totalReviews}<span class="ts-unit">件</span>`;

  if (allDoneEl) {
    const allReviewsDone = totalReviews === 0 && hasAnyTask;
    allDoneEl.style.display = allReviewsDone ? 'block' : 'none';
  }
}

/* ---------- 進捗入力 UI ---------- */

function buildProgControlHtml(rangeStart, rangeEnd, recordedVal, type, statusHtml, inputAttrs) {
  const isWordType  = (type === 'word' || type === 'word-review');
  const unitWord    = isWordType ? '個' : 'ページ';
  const unitLabel   = isWordType ? '番まで' : 'ページまで';
  const plannedCount = rangeEnd - rangeStart + 1;

  const rv       = recordedVal !== '' ? parseInt(recordedVal, 10) : null;
  const isDone   = rv !== null && rv >= rangeEnd;
  const isNotProgressed = rv !== null && rv === rangeStart - 1;
  const isPartial = rv !== null && rv > (rangeStart - 1) && rv < rangeEnd;
  const completedCount = rv !== null ? Math.max(0, rv - rangeStart + 1) : 0;
  const pct      = plannedCount > 0 ? Math.min(100, Math.round(completedCount / plannedCount * 100)) : 0;
  const displayVal = rv !== null ? rv : rangeEnd;

  const step1LabelClass = isDone ? ' step-done'
    : isPartial       ? ' step-partial'
    : isNotProgressed ? ' step-not-progressed'
    : '';
  const isReviewType = (type === 'word-review' || type === 'book-review');
  const extraPages   = rv !== null && rv > rangeEnd ? rv - rangeEnd : 0;
  const extraUnit    = isWordType ? '個追加' : 'ページ追加';

  return `
    <div class="prog-control-ui"
         data-range-start="${rangeStart}"
         data-range-end="${rangeEnd}"
         data-type="${type}">
      <input type="number" class="progress-num-input" style="display:none"
             min="${rangeStart - 1}" max="${rangeEnd + 50}"
             value="${recordedVal}" ${inputAttrs}>
      <div class="prog-step1-label${step1LabelClass}">完了しましたか？</div>
      <div class="prog-toggle">
        <button type="button" class="prog-btn prog-btn-done${isDone ? ' prog-btn-active' : ''}">
          ✅ 完了
        </button>
        <button type="button" class="prog-btn prog-btn-partial${isPartial ? ' prog-btn-active' : ''}">
          ⚠️ 途中まで
        </button>
        <button type="button" class="prog-btn prog-btn-not-progressed${isNotProgressed ? ' prog-btn-active' : ''}">
          🚫 進んでいない
        </button>
      </div>
      ${statusHtml ? `<div class="prog-status-wrap">${statusHtml}</div>` : ''}
      <div class="prog-partial-panel"${isPartial ? '' : ' style="display:none"'}>
        <div class="prog-partial-heading">どこまで進みましたか？</div>
        <div class="prog-count-row">
          <span class="prog-count-val">${completedCount}</span>
          <span class="prog-count-total">/ ${plannedCount}${unitWord}完了</span>
          <div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="prog-stepper">
          <input type="number" class="prog-display-input"
                 value="${displayVal}"
                 min="${rangeStart - 1}" max="${rangeEnd + 50}"
                 inputmode="numeric" pattern="[0-9]*"
                 aria-label="${unitLabel}入力">
          <span class="prog-unit">${unitLabel}</span>
        </div>
      </div>
      ${!isReviewType ? `
      <div class="prog-extra-panel"${isDone && extraPages > 0 ? '' : ' style="display:none"'}>
        <div class="prog-extra-heading">さらに余剰${isWordType ? '個数' : 'ページ'}はありましたか？</div>
        <div class="prog-extra-options">
          <button type="button" class="prog-extra-no-btn">追加なし</button>
          <div class="prog-extra-input-row">
            <button type="button" class="prog-extra-step" data-delta="-1">−1</button>
            <input type="number" class="prog-extra-input"
                   value="${extraPages}" min="0" max="999" inputmode="numeric">
            <button type="button" class="prog-extra-step" data-delta="+1">+1</button>
            <span class="prog-extra-unit">${extraUnit}</span>
            <button type="button" class="prog-extra-confirm-btn">✅ 記録</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;
}

/**
 * 修正箇所：フォーム初期描画時は recordedVal を空文字に設定し、保存後にフォーム内の選択・数値がクリア（初期化）されるように改善
 */
function buildProgressInputSection(dateStr, dayWords, dayBooks, baseId, dayWordReviews, dayBookReviews) {
  baseId = baseId || dateStr;
  dayWordReviews = dayWordReviews || [];
  dayBookReviews = dayBookReviews || [];
  const existingRecords = dailyProgress.filter(p => p.date === dateStr);
  const hasAnyRecord = existingRecords.length > 0;

  let itemsHtml = '';

  // ── 新規：単語チャンク ──────────────────────────────────────
  dayWords.forEach(w => {
    const chunkDate = w.carriedForward ? (w.originalDate || w.date) : w.date;
    const chunkKey  = `${w.entryId}_${chunkDate}_${w.rangeStart}`;

    const rec = existingRecords.find(p => (p.entryId === chunkKey || p.originEntryId === w.entryId) && p.type === 'word');
    // 入力フォームは保存後に選択が消えるよう、常にクリア状態('')で初期化
    const recordedVal = '';
    const plannedCount = w.rangeEnd - w.rangeStart + 1;
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= w.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= w.rangeEnd ? '✅ 記録済み (完了)' : `⚠️ 記録済み (${rec.actualEnd - w.rangeStart + 1}/${plannedCount}個完了)`}
         </span>`
      : '';
    itemsHtml += `
      <div class="progress-item">
        <span class="progress-plan-label">単語 ${w.rangeStart}〜${w.rangeEnd}（予定 ${plannedCount}個）</span>
        ${buildProgControlHtml(
          w.rangeStart, w.rangeEnd, recordedVal, 'word', statusHtml,
          `data-entry-id="${chunkKey}" data-origin-entry-id="${w.entryId}" data-type="word" data-planned-start="${w.rangeStart}" data-planned-end="${w.rangeEnd}" data-date="${dateStr}"`
        )}
      </div>`;
  });

  // ── 新規：参考書チャンク ─────────────────────────────────────
  dayBooks.forEach(b => {
    const planId = b.planId;
    const chunkOriginalDate = b.carriedForward ? (b.originalDate || b.date) : b.date;
    const chunkEntryId = `${planId}_${chunkOriginalDate}_${b.rangeStart}`;
    const rec = existingRecords.find(p => (p.entryId === chunkEntryId || p.planId === planId) && p.type === 'book');
    const recordedVal = '';
    const plannedCount = b.rangeEnd - b.rangeStart + 1;
    const cfNote = b.carriedForward
      ? buildCarryBadgeHtml(b.originalDate)
      : (b.isCarriedNew ? buildCarryBadgeHtml(b.originalDate || null) : '');
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= b.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= b.rangeEnd ? '✅ 記録済み (完了)' : `⚠️ 記録済み (${rec.actualEnd - b.rangeStart + 1}/${plannedCount}ページ完了)`}
         </span>`
      : '';
    itemsHtml += `
      <div class="progress-item">
        <span class="progress-plan-label">${escapeHtml(b.bookName)} ${b.rangeStart}〜${b.rangeEnd}（予定 ${plannedCount}ページ）${cfNote}</span>
        ${buildProgControlHtml(
          b.rangeStart, b.rangeEnd, recordedVal, 'book', statusHtml,
          `data-entry-id="${chunkEntryId}" data-plan-id="${planId}" data-type="book" data-planned-start="${b.rangeStart}" data-planned-end="${b.rangeEnd}" data-date="${dateStr}" data-book-name="${escapeHtml(b.bookName)}"`
        )}
      </div>`;
  });

  // ── 復習：単語 ──────────────────────────────────────────────
  const pendingWordReviews = dayWordReviews.filter(r => !r.done);
  if (pendingWordReviews.length > 0) {
    itemsHtml += `<div class="progress-review-divider">🔁 復習タスク（単語）の進捗</div>`;
    pendingWordReviews.forEach(r => {
      const tier = getIntervalTier(r.interval);
      const rec  = existingRecords.find(p => p.reviewKey === r.key && p.type === 'word-review');
      const recordedVal  = '';
      const plannedCount = r.rangeEnd - r.rangeStart + 1;
      const statusHtml = rec
        ? `<span class="progress-status-badge ${rec.actualEnd >= r.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
             ${rec.actualEnd >= r.rangeEnd ? '✅ 記録済み' : `⚠️ 記録済み (${rec.actualEnd - r.rangeStart + 1}/${plannedCount}個)`}
           </span>`
        : '';
      const reviewBadgeWord = buildReviewBadgeHtml(r.interval, r.delayedDays);
      itemsHtml += `
        <div class="progress-item review-item t${tier}">
          <span class="progress-plan-label">
            ${reviewBadgeWord}
            単語 ${r.rangeStart}〜${r.rangeEnd}（${plannedCount}個）
          </span>
          ${buildProgControlHtml(
            r.rangeStart, r.rangeEnd, recordedVal, 'word-review', statusHtml,
            `data-review-key="${r.key}" data-type="word-review" data-planned-start="${r.rangeStart}" data-planned-end="${r.rangeEnd}" data-date="${dateStr}"`
          )}
        </div>`;
    });
  }

  // ── 復習：参考書 ─────────────────────────────────────────────
  const pendingBookReviews = dayBookReviews.filter(r => !r.done);
  if (pendingBookReviews.length > 0) {
    itemsHtml += `<div class="progress-review-divider">📚 復習タスク（参考書）の進捗</div>`;
    pendingBookReviews.forEach(r => {
      const tier = getIntervalTier(r.interval);
      const rec  = existingRecords.find(p => p.reviewKey === r.key && p.type === 'book-review');
      const recordedVal  = '';
      const plannedCount = r.rangeEnd - r.rangeStart + 1;
      const statusHtml = rec
        ? `<span class="progress-status-badge ${rec.actualEnd >= r.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
             ${rec.actualEnd >= r.rangeEnd ? '✅ 記録済み' : `⚠️ 記録済み (${rec.actualEnd - r.rangeStart + 1}/${plannedCount}ページ)`}
           </span>`
        : '';
      const reviewBadgeBook = buildReviewBadgeHtml(r.interval, r.delayedDays);
      itemsHtml += `
        <div class="progress-item review-item t${tier}">
          <span class="progress-plan-label">
            ${reviewBadgeBook}
            ${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}（${plannedCount}ページ）
          </span>
          ${buildProgControlHtml(
            r.rangeStart, r.rangeEnd, recordedVal, 'book-review', statusHtml,
            `data-review-key="${r.key}" data-type="book-review" data-planned-start="${r.rangeStart}" data-planned-end="${r.rangeEnd}" data-date="${dateStr}" data-book-name="${escapeHtml(r.bookName)}"`
          )}
        </div>`;
    });
  }

  if (!itemsHtml) return null;

  const savedLabel = hasAnyRecord
    ? `<span class="progress-recorded-badge">✓ 記録済み</span>`
    : '';

  return `
    <div class="progress-section" id="progress-section-${baseId}">
      <div class="progress-section-title">
        📝 今日の進捗を入力
        ${savedLabel}
      </div>
      ${itemsHtml}
      <div class="ahead-banner" id="ahead-banner-${baseId}" style="display:none;">
        <span class="ahead-text" id="ahead-text-${baseId}"></span>
        <button class="btn-primary" style="font-size:.8rem; padding:7px 12px;"
                onclick="handleProgressSave('${dateStr}', '${baseId}')">
          スケジュールを再調整する
        </button>
      </div>
      <div class="behind-note" id="behind-note-${baseId}" style="display:none;"></div>
      <div class="not-progressed-note" id="not-progressed-note-${baseId}" style="display:none;"></div>
      <div class="progress-save-row">
        <button class="btn-primary" style="font-size:.85rem;"
                onclick="handleProgressSave('${dateStr}', '${baseId}')">
          📌 進捗を記録してスケジュールを調整
        </button>
        ${hasAnyRecord ? `<button class="btn-ghost" style="font-size:.8rem;"
                onclick="handleProgressClear('${dateStr}')">記録をリセット</button>` : ''}
      </div>
    </div>`;
}

function initProgressControls(container, dateStr, baseId) {
  baseId = baseId || dateStr;

  container.querySelectorAll('.prog-control-ui').forEach(ui => {
    const hiddenInput    = ui.querySelector('.progress-num-input');
    if (!hiddenInput) return;

    const btnDone           = ui.querySelector('.prog-btn-done');
    const btnPartial        = ui.querySelector('.prog-btn-partial');
    const btnNotProgressed  = ui.querySelector('.prog-btn-not-progressed');
    const partialPanel      = ui.querySelector('.prog-partial-panel');
    const progDisplay    = ui.querySelector('.prog-display');
    const progDisplayInput = ui.querySelector('.prog-display-input');
    const barFill        = ui.querySelector('.prog-bar-fill');
    const countValEl     = ui.querySelector('.prog-count-val');
    const step1Label     = ui.querySelector('.prog-step1-label');
    const extraPanel     = ui.querySelector('.prog-extra-panel');

    const rangeStart   = parseInt(hiddenInput.dataset.plannedStart, 10);
    const rangeEnd     = parseInt(hiddenInput.dataset.plannedEnd,   10);
    const plannedCount = rangeEnd - rangeStart + 1;

    function updateDisplay(val) {
      const clampedVal     = Math.max(rangeStart - 1, Math.min(rangeEnd + 50, val));
      const completedCount = Math.max(0, clampedVal - rangeStart + 1);
      const pct            = plannedCount > 0 ? Math.min(100, Math.round(completedCount / plannedCount * 100)) : 0;

      if (progDisplay)      progDisplay.textContent = clampedVal;
      if (progDisplayInput) progDisplayInput.value  = clampedVal;
      if (barFill)          barFill.style.width      = pct + '%';
      if (countValEl)       countValEl.textContent   = completedCount;

      hiddenInput.value = clampedVal;
      hiddenInput.dispatchEvent(new Event('input'));
    }

    function updateStep1Label(mode) {
      if (!step1Label) return;
      step1Label.classList.toggle('step-done',          mode === 'done');
      step1Label.classList.toggle('step-partial',       mode === 'partial');
      step1Label.classList.toggle('step-not-progressed', mode === 'not-progressed');
    }

    function setActiveState(mode) {
      if (btnDone)           btnDone.classList.toggle('prog-btn-active',           mode === 'done');
      if (btnPartial)        btnPartial.classList.toggle('prog-btn-active',        mode === 'partial');
      if (btnNotProgressed)  btnNotProgressed.classList.toggle('prog-btn-active',  mode === 'not-progressed');
      if (partialPanel)      partialPanel.style.display = (mode === 'partial') ? 'block' : 'none';
      if (extraPanel && mode !== 'done') extraPanel.style.display = 'none';
      updateStep1Label(mode);
    }

    if (btnDone) {
      btnDone.addEventListener('click', () => {
        updateDisplay(rangeEnd);
        setActiveState('done');
        if (extraPanel) {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          if (extraInput) extraInput.value = '0';
          extraPanel.style.display = 'block';
        }
      });
    }

    if (extraPanel) {
      const extraNoBtn = extraPanel.querySelector('.prog-extra-no-btn');
      if (extraNoBtn) {
        extraNoBtn.addEventListener('click', () => {
          extraPanel.style.display = 'none';
          hiddenInput.dispatchEvent(new Event('input'));
        });
      }

      extraPanel.querySelectorAll('.prog-extra-step').forEach(btn => {
        btn.addEventListener('click', () => {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          if (!extraInput) return;
          const delta   = parseInt(btn.dataset.delta, 10);
          const current = parseInt(extraInput.value, 10) || 0;
          extraInput.value = Math.max(0, current + delta);
        });
      });

      const extraConfirmBtn = extraPanel.querySelector('.prog-extra-confirm-btn');
      if (extraConfirmBtn) {
        extraConfirmBtn.addEventListener('click', () => {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          const extraPages = Math.max(0, parseInt(extraInput?.value, 10) || 0);
          hiddenInput.value = rangeEnd + extraPages;
          hiddenInput.dispatchEvent(new Event('input'));
          extraPanel.style.display = 'none';
        });
      }
    }

    if (btnPartial) {
      btnPartial.addEventListener('click', () => {
        const currentVal = parseInt(hiddenInput.value, 10);
        if (isNaN(currentVal) || currentVal >= rangeEnd || currentVal === rangeStart - 1) {
          const midVal = rangeStart - 1 + Math.max(1, Math.floor(plannedCount * 0.5));
          updateDisplay(Math.min(rangeEnd - 1, midVal));
        }
        setActiveState('partial');
        if (progDisplayInput) {
          setTimeout(() => progDisplayInput.focus(), 50);
        }
      });
    }

    if (btnNotProgressed) {
      btnNotProgressed.addEventListener('click', () => {
        hiddenInput.value = rangeStart - 1;
        hiddenInput.dispatchEvent(new Event('input'));
        setActiveState('not-progressed');
      });
    }

    if (progDisplayInput) {
      progDisplayInput.addEventListener('input', () => {
        const val = parseInt(progDisplayInput.value, 10);
        if (!isNaN(val)) {
          const clampedVal = Math.max(rangeStart - 1, Math.min(rangeEnd + 50, val));
          const completedCount = Math.max(0, clampedVal - rangeStart + 1);
          const pct = plannedCount > 0 ? Math.min(100, Math.round(completedCount / plannedCount * 100)) : 0;
          if (barFill)    barFill.style.width   = pct + '%';
          if (countValEl) countValEl.textContent = completedCount;
          if (progDisplay) progDisplay.textContent = clampedVal;
          hiddenInput.value = clampedVal;
          hiddenInput.dispatchEvent(new Event('input'));
          if (clampedVal >= rangeEnd) {
            setActiveState('done');
          } else if (clampedVal === rangeStart - 1) {
            setActiveState('not-progressed');
          } else {
            setActiveState('partial');
          }
        }
      });
      progDisplayInput.addEventListener('blur', () => {
        const val = parseInt(hiddenInput.value, 10);
        if (!isNaN(val)) progDisplayInput.value = val;
      });
      progDisplayInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); progDisplayInput.blur(); }
      });
    }

  });
}

function attachProgressInputHandlers(container, dateStr, baseId) {
  baseId = baseId || dateStr;
  container.querySelectorAll('.progress-num-input').forEach(input => {
    input.addEventListener('input', () => previewProgressAdjustment(container, dateStr, baseId));
  });
  initProgressControls(container, dateStr, baseId);
}

function previewProgressAdjustment(container, dateStr, baseId) {
  baseId = baseId || dateStr;
  let hasAhead = false, hasBehind = false, hasNotProgressed = false;
  let aheadMessages = [], behindMessages = [], notProgressedLabels = [];

  container.querySelectorAll('.progress-num-input').forEach(input => {
    const val = parseInt(input.value, 10);
    if (isNaN(val)) return;
    const plannedEnd   = parseInt(input.dataset.plannedEnd,   10);
    const plannedStart = parseInt(input.dataset.plannedStart, 10);
    const type         = input.dataset.type;

    const isReview = type === 'word-review' || type === 'book-review';
    const unit = (type === 'word' || type === 'word-review') ? '個' : 'ページ';
    const prefix = isReview ? '復習 ' : '';
    const label = (type === 'word' || type === 'word-review')
      ? `${prefix}単語 ${plannedStart}〜${plannedEnd}`
      : `${prefix}${input.dataset.bookName || '参考書'} ${plannedStart}〜${plannedEnd}`;

    if (!isReview && val === plannedStart - 1) {
      hasNotProgressed = true;
      notProgressedLabels.push(label);
    } else if (!isReview && val > plannedEnd) {
      hasAhead = true;
      aheadMessages.push(`${label}: ${val - plannedEnd}${unit}多く進みました！`);
    } else if (val < plannedEnd && val >= plannedStart) {
      hasBehind = true;
      const diff = plannedEnd - val;
      if (isReview) {
        behindMessages.push(`${label}: ${diff}${unit}残っています`);
      } else {
        behindMessages.push(`${label}: ${diff}${unit}残っています → 残りのスケジュールに自動で分散します`);
      }
    }
  });

  const aheadBanner         = container.querySelector(`#ahead-banner-${baseId}`);
  const aheadText           = container.querySelector(`#ahead-text-${baseId}`);
  const behindNote          = container.querySelector(`#behind-note-${baseId}`);
  const notProgressedNote   = container.querySelector(`#not-progressed-note-${baseId}`);

  if (aheadBanner && aheadText) {
    if (hasAhead) {
      aheadText.textContent = '🎉 予定より進んでいます！ ' + aheadMessages.join(' / ') + ' 記録するとスケジュールが更新されます。';
      aheadBanner.style.display = 'flex';
    } else {
      aheadBanner.style.display = 'none';
    }
  }
  if (behindNote) {
    if (hasBehind) {
      behindNote.innerHTML = '⚠️ ' + behindMessages.map(m => escapeHtml(m)).join('<br>');
      behindNote.style.display = 'block';
    } else {
      behindNote.style.display = 'none';
    }
  }
  if (notProgressedNote) {
    if (hasNotProgressed) {
      notProgressedNote.innerHTML = notProgressedLabels
        .map(l => `🚫 ${escapeHtml(l)}: 進んでいないため、この範囲は次の学習日に繰り越されます。`)
        .join('<br>');
      notProgressedNote.style.display = 'block';
    } else {
      notProgressedNote.style.display = 'none';
    }
  }
}

/**
 * 進捗保存＆スケジュール再割り当て
 */
function handleProgressSave(dateStr, baseId) {
  baseId = baseId || dateStr;
  const container = document.getElementById(`progress-section-${baseId}`);
  if (!container) return;

  const inputs = container.querySelectorAll('.progress-num-input');
  let saved = 0;
  const savedRecords = [];

  inputs.forEach(input => {
    const val = parseInt(input.value, 10);
    if (isNaN(val)) return;

    const type = input.dataset.type;
    const plannedStart = parseInt(input.dataset.plannedStart, 10);
    const plannedEnd   = parseInt(input.dataset.plannedEnd,   10);
    const bookName     = input.dataset.bookName || '';

    if (type === 'word-review' || type === 'book-review') {
      const reviewKey = input.dataset.reviewKey;
      dailyProgress = dailyProgress.filter(
        p => !(p.date === dateStr && p.reviewKey === reviewKey && p.type === type)
      );
      const record = {
        id: 'dp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        date: dateStr,
        reviewKey,
        type,
        plannedStart,
        plannedEnd,
        actualEnd: val,
        bookName,
        notProgressed: val === plannedStart - 1
      };
      dailyProgress.push(record);
      savedRecords.push(record);
      saved++;
    } else {
      const entryId = input.dataset.entryId;
      const originEntryId = input.dataset.originEntryId || undefined;
      const planId = input.dataset.planId || entryId;
      dailyProgress = dailyProgress.filter(
        p => !(p.date === dateStr && p.entryId === entryId && p.type === type)
      );
      const record = {
        id: 'dp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        date: dateStr,
        entryId,
        originEntryId: type === 'word' ? originEntryId : undefined,
        planId: type === 'book' ? planId : undefined,
        type,
        plannedStart,
        plannedEnd,
        actualEnd: val,
        bookName,
        notProgressed: val === plannedStart - 1
      };
      dailyProgress.push(record);
      savedRecords.push(record);
      saved++;
    }
  });

  if (saved === 0) {
    alert('進捗を入力してから保存してください。');
    return;
  }

  saveDailyProgress();
  
  // スケジュール全体の再計算と描画（フォームがクリア初期化され、今後のスケジュールへ即座に反映される）
  renderIntegratedSchedule();
  refreshAllSchedules();
  renderRefTodayCard();

  const wordRecordsForPreview = savedRecords.filter(r => r.type === 'word');
  if (wordRecordsForPreview.length > 0) {
    const progressSectionEl = document.getElementById(`progress-section-${dateStr}`);
    if (progressSectionEl) {
      const existing = progressSectionEl.querySelector(`#word-review-preview-${dateStr}`);
      if (existing) existing.remove();
      const previewHtml = buildWordReviewPreviewHtml(dateStr, wordRecordsForPreview);
      if (previewHtml) {
        const previewEl = document.createElement('div');
        previewEl.id = `word-review-preview-${dateStr}`;
        previewEl.innerHTML = previewHtml;
        progressSectionEl.appendChild(previewEl);
      }
    }
  }
}

function buildWordReviewPreviewHtml(dateStr, wordRecords) {
  if (!wordRecords || wordRecords.length === 0) return '';

  let wordsHtml = '';
  let hasAnyReview = false;

  wordRecords.forEach(rec => {
    if (rec.notProgressed) {
      wordsHtml += `
        <div class="progressed-review-book">
          <div class="progressed-review-book-name">
            📖 単語 ${rec.plannedStart}〜${rec.plannedEnd}
            <span class="range-badge">${rec.plannedStart}〜${rec.plannedEnd}番</span>
          </div>
          <div class="progressed-undershot" style="background:#fff7ed;border-color:#fed7aa;color:#9a3412;">
            🚫 進んでいないため、この範囲は次の学習日に繰り越されます。
          </div>
        </div>`;
      return;
    }

    const targetId = rec.originEntryId || rec.entryId;
    const entry = entries.find(e => e.id === targetId || rec.entryId.startsWith(e.id + '_'));
    if (!entry) return;

    hasAnyReview = true;
    const actualEnd  = rec.actualEnd;
    const diff       = actualEnd - rec.plannedEnd;

    let diffHtml = '';
    if (diff > 0) {
      diffHtml = `<div class="progressed-overshot">🎉 予定より ${diff}個多く進みました！ 余分に進んだ分も復習対象に追加されました。</div>`;
    } else if (diff < 0) {
      diffHtml = `<div class="progressed-undershot">⚠️ ${Math.abs(diff)}個残りました。残りは以降のスケジュールに自動分散されました。</div>`;
    }

    const slotsHtml = DEFAULT_INTERVALS.map(n => {
      const d = parseISO(formatISO(addDays(parseISO(dateStr), n)));
      const wdLabel  = ['日','月','火','水','木','金','土'][d.getDay()];
      const dispDate = `${d.getMonth()+1}/${d.getDate()}（${wdLabel}）`;
      const tier      = getIntervalTier(n);
      const tierLabel = ['', 'Lv.1 初期', 'Lv.2 定着', 'Lv.3 強化', 'Lv.4 仕上げ'][tier];
      return `<span class="progressed-review-slot slot-t${tier}">
        <span class="slot-date">${dispDate}</span>
        <span class="slot-lv">${n}日後 ${tierLabel}</span>
      </span>`;
    }).join('');

    wordsHtml += `
      <div class="progressed-review-book">
        <div class="progressed-review-book-name">
          📖 単語 ${rec.plannedStart}〜${actualEnd}
          <span class="range-badge">${rec.plannedStart}〜${actualEnd}番</span>
        </div>
        ${diffHtml}
        <div style="font-size:.8rem;color:var(--ink-soft);margin-bottom:6px;font-weight:600;">📅 この範囲の復習予定日：</div>
        <div class="progressed-review-slots">${slotsHtml}</div>
      </div>`;
  });

  if (!wordsHtml) return '';

  const sectionTitle = hasAnyReview
    ? '📖 単語の進捗を記録 — 復習スケジュールが追加されました'
    : '📖 単語の進捗を記録 — 繰り越し処理が完了しました';

  return `<div class="progressed-review-section" style="margin-top:16px;">
    <div class="progressed-review-title">${sectionTitle}</div>
    ${wordsHtml}
  </div>`;
}

function handleProgressClear(dateStr) {
  if (!confirm(`${dateStr} の進捗記録をリセットしますか？\nスケジュールが元の計画に戻ります。`)) return;
  dailyProgress = dailyProgress.filter(p => p.date !== dateStr);
  saveDailyProgress();
  renderIntegratedSchedule();
  refreshAllSchedules();
  renderRefTodayCard();
}

function renderTodayNew(){
  const box = document.getElementById('todayNewBox');
  const todayIso = todayISO();
  const allChunks = entries.flatMap(computeChunksForEntry);
  const todayChunks = allChunks.filter(c => c.date === todayIso);
  if(todayChunks.length === 0){
    box.innerHTML = `<div class="empty-mini">今日の新規範囲はありません。</div>`;
  }else{
    box.innerHTML = todayChunks.map(c => `<span class="today-new-tag">${c.rangeStart}〜${c.rangeEnd}</span>`).join('');
  }
}

function renderRefTodayCard() {
  const newBox    = document.getElementById('refTodayNewBox');
  const reviewList = document.getElementById('refTodayReviewList');
  if (!newBox || !reviewList) return;

  const todayStr = todayISO();
  const { refChunks, refReviews } = buildScheduleData();

  const todayChunks = refChunks.filter(c => c.date === todayStr);
  if (todayChunks.length === 0) {
    newBox.innerHTML = '<div class="empty-mini">今日の参考書範囲はありません。</div>';
  } else {
    newBox.innerHTML = todayChunks.map(c => {
      const cfBadge = c.carriedForward
        ? buildCarryBadgeHtml(c.originalDate)
        : (c.isCarriedNew ? buildCarryBadgeHtml(c.originalDate || null) : '');
      return `<span class="today-ref-tag">${escapeHtml(c.bookName)}<br><span style="font-weight:400;font-size:.82em;">p.${c.rangeStart}〜${c.rangeEnd}</span>${cfBadge ? '<br>' + cfBadge : ''}</span>`;
    }).join('');
  }

  const todayReviews = refReviews.filter(r => r.date === todayStr);
  if (todayReviews.length === 0) {
    reviewList.innerHTML = '<div class="empty-mini">今日の参考書復習はありません。</div>';
  } else {
    const sorted = [...todayReviews].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    const itemsHtml = sorted.map(r => {
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      return `<div class="ref-review-item${r.done ? ' is-done' : ''}">
        <div class="ref-book-info">
          <span class="ref-book-title">${escapeHtml(r.bookName)}</span>
          <span class="ref-book-range">p.${r.rangeStart}〜${r.rangeEnd}</span>
        </div>
        <label class="tag tag-ref-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"
               style="cursor:pointer; padding:6px 12px; display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}>
          <span class="stamp">◎</span>
          ${reviewBadge}
        </label>
      </div>`;
    }).join('');
    reviewList.innerHTML = `<div class="due-list" style="gap:10px;">${itemsHtml}</div>`;
    attachReviewCheckHandlers(reviewList);
  }

}

function renderAll(){
  renderEntryList();
  renderSchedule();
  renderTodayNew();
}

async function handleAdd(){
  const startNum = Number(document.getElementById('startNum').value);
  const endNum = Number(document.getElementById('endNum').value);
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const weekdays = getCheckedValues('weekdayRow');
  const reviewWeekdays = getCheckedValues('reviewWeekdayRow');
  const intervals = getCheckedValues('intervalRow');
  const errorEl = document.getElementById('errorMsg');
  const planMode = document.querySelector('input[name="planMode"]:checked').value;
  const amountPerDay = Number(document.getElementById('amountPerDay').value);
  errorEl.textContent = '';

  if(!startNum || !endNum || endNum < startNum){
    errorEl.textContent = '開始番号・終了番号を正しく入力してください（終了番号は開始番号以上）。'; return;
  }
  if(!startDate){ errorEl.textContent = '開始日を選択してください。'; return; }
  
  if(planMode === 'byRange') {
    if(!endDate){ errorEl.textContent = '終了日を選択してください。'; return; }
    if(new Date(endDate) < new Date(startDate)){ errorEl.textContent = '終了日は開始日以降の日付にしてください。'; return; }
  }

  if(weekdays.length === 0){ errorEl.textContent = '学習する曜日を1つ以上選んでください。'; return; }
  if(intervals.length === 0){ errorEl.textContent = '復習のタイミングを1つ以上選んでください。'; return; }
  if(planMode === 'byAmount' && (!amountPerDay || amountPerDay <= 0)){
    errorEl.textContent = '1日あたりの単語数を正しく入力してください。'; return;
  }

  entries.push({ id: 'e' + Date.now(), startNum, endNum, startDate, endDate, weekdays, reviewWeekdays, intervals, planMode, amountPerDay });
  await saveEntries();
  renderAll();
}

async function handleReset(){
  if(!confirm('登録した範囲をすべて削除します。よろしいですか？')) return;
  entries = [];
  await saveEntries();
  renderAll();
}

/* ---------- leech words (shared) ---------- */

async function loadLeech(){
  try{
    const raw = localStorage.getItem(LEECH_KEY);
    leechWords = raw ? JSON.parse(raw) : [];
  }catch(e){ leechWords = []; }
}
async function saveLeech(){
  try{
    localStorage.setItem(LEECH_KEY, JSON.stringify(leechWords));
  }catch(e){ console.error('Storage error:', e); }
}

function nextDateForStep(step){
  const idx = Math.min(step, LEECH_INTERVALS.length - 1);
  return formatISO(addDays(new Date(), LEECH_INTERVALS[idx]));
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
    id: 'w' + Date.now(), word, meaning, stepIndex: 0,
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
  if(newStep >= LEECH_INTERVALS.length){
    entry.status = 'graduated';
    entry.gradDate = todayISO();
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
  const todayIso = todayISO();
  const active = leechWords.filter(w => w.status === 'active');
  const graduated = leechWords.filter(w => w.status === 'graduated');
  const due = active.filter(w => w.nextReviewDate <= todayIso)
                     .sort((a,b) => a.nextReviewDate.localeCompare(b.nextReviewDate));

  const dueList = document.getElementById('dueList');
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
            <div><span class="word">${w.word}</span>${overdue ? '<span class="overdue">期限超過</span>' : ''}${warn}</div>
            <button class="reveal-btn" data-action="reveal" data-id="${w.id}">意味を確認</button>
          </div>
          <div class="meaning-text" data-role="meaning" data-id="${w.id}">${w.meaning || '（メモ未登録：口頭で確認）'}</div>
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

  const activeSorted = active.slice().sort((a,b) => a.nextReviewDate.localeCompare(b.nextReviewDate));
  document.getElementById('activeSummary').textContent = `登録中の苦手単語（${activeSorted.length}）`;
  const activeTable = document.getElementById('activeTable');
  if(activeSorted.length === 0){
    activeTable.innerHTML = `<tr><td class="empty-mini">まだ登録されていません。</td></tr>`;
  }else{
    activeTable.innerHTML = `
      <tr><th>単語</th><th>次回レビュー</th><th>ミス回数</th><th></th></tr>
      ${activeSorted.map(w => `
      <tr>
       <td>
        ${w.word}
        <button onclick="speakWord('${w.word}')" style="background:none; border:none; cursor:pointer; font-size:1rem; margin-left:6px;">🔊</button>
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

  document.getElementById('graduatedSummary').textContent = `卒業した単語（${graduated.length}）`;
  const gradTable = document.getElementById('graduatedTable');
  if(graduated.length === 0){
    gradTable.innerHTML = `<tr><td class="empty-mini">まだありません。</td></tr>`;
  }else{
    gradTable.innerHTML = `
      <tr><th>単語</th><th>卒業日</th><th></th></tr>
      ${graduated.map(w => `
        <tr>
          <td>${w.word}</td>
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
function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

async function loadScores(){
  try{
    const raw = localStorage.getItem(SCORE_KEY);
    scoreRecords = raw ? JSON.parse(raw) : [];
  }catch(e){ scoreRecords = []; }
}
async function saveScores(){
  try{
    localStorage.setItem(SCORE_KEY, JSON.stringify(scoreRecords));
  }catch(e){ console.error('Storage error:', e); }
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

function handleExamTypeChange(selectEl) {
  const customInput = document.getElementById('scoreExamTypeCustom');
  if (selectEl.value === 'custom') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
  }
}

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
  errorEl.textContent = '';

  const subject = subjectEl.value.trim();
  const score = Number(valueEl.value);
  const total = Number(totalEl.value) || 100;
  const examType = getSelectedExamType();
  const deviationRaw = deviationEl.value.trim();
  const deviation = deviationRaw !== '' ? Number(deviationRaw) : null;

  if(!subject){ errorEl.textContent = '教科を入力してください。'; return; }
  if(valueEl.value === '' || isNaN(score) || score < 0){ errorEl.textContent = '得点を正しく入力してください。'; return; }
  if(total <= 0){ errorEl.textContent = '満点は1以上で入力してください。'; return; }
  if(deviation !== null && (isNaN(deviation) || deviation < 0 || deviation > 100)){
    errorEl.textContent = '偏差値は0〜100の数値で入力してください（省略可）。'; return;
  }

  scoreRecords.push({
    id: 's' + Date.now(),
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

  const devBox = document.getElementById('deviationChartBox');
  const devWithData = scoreRecords
    .filter(r => r.deviation != null && r.deviation !== '' && !isNaN(Number(r.deviation)))
    .sort((a,b) => (a.date||'').localeCompare(b.date||''))
    .slice(-10);

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

/* ---------- Test Mode Logic ---------- */
let testQueue = [];
let currentTestIdx = 0;
let testSessionResults = [];

document.getElementById('startTestBtn').addEventListener('click', () => {
  const mode = document.getElementById('testMode').value;
  const activeWords = leechWords.filter(w => w.status === 'active');
  
  if(activeWords.length === 0) {
    alert('現在、テストできる単語が登録されていません。');
    return;
  }

  if(mode === 'all') {
    testQueue = [...activeWords];
  } else if(mode === 'warn') {
    testQueue = activeWords.filter(w => w.missCount >= LEECH_WARN_THRESHOLD);
    if(testQueue.length === 0) { alert('現在、要注意の単語はありません。'); return; }
  } else if(mode === 'random10') {
    testQueue = [...activeWords].sort(() => 0.5 - Math.random()).slice(0, 10);
  }
  else if(mode === 'miss1') {
    testQueue = activeWords.filter(w => w.missCount === 1);
    if(testQueue.length === 0) { alert('現在、ミス1回の単語はありません。'); return; }
  }

  currentTestIdx = 0;
  testSessionResults = [];
  document.getElementById('testArea').style.display = 'block';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('testModal').classList.add('active');
  
  showTestWord();
});

function showTestWord() {
  if(currentTestIdx >= testQueue.length) {
    finishTest();
    return;
  }
  const wordData = testQueue[currentTestIdx];
  document.getElementById('testProgress').textContent = `問題 ${currentTestIdx + 1} / ${testQueue.length}`;
  document.getElementById('testWordDisplay').textContent = wordData.word;
  document.getElementById('testMeaningDisplay').textContent = wordData.meaning || '（メモ未登録：口頭で確認）';
}
