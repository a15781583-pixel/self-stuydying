const STORAGE_KEY = 'vocab-plan-entries';
const LEECH_KEY = 'vocab-leech-words';
const SCORE_KEY = 'vocab-score-records';
const ANALYSIS_KEY = 'vocab-weakness-analysis';
const DAILY_PROGRESS_KEY = 'vocab-daily-progress'; // 日別進捗記録
const MONTH_GOAL_KEY = 'vocab-month-goal'; // 今月の目標
const WEEKDAYS = ['日','月','火','水','木','金','土'];
const DEFAULT_WEEKDAYS = [1,2,3,4,5,6];
const DEFAULT_INTERVALS = [1,3,7,14];
const LEECH_WARN_THRESHOLD = 2;
const COLORS = { ink:'#1E2A44', gold:'#a97c1f', red:'#B23A2E', success:'#3a6b4c', grid:'#CBD5E3' };
/* ---------- 参考書用の変数 ---------- */
const REF_STORAGE_KEY = 'vocab-reference-entries';
/* ---------- 復習の完了チェック用 ---------- */
// 「復習日ごとに、その項目をクリアできたか」を記録しておくためのキー。
// ここに入っている項目＝クリア済み。入っていない項目は「まだクリアしていない」とみなす。
const REVIEW_DONE_KEY = 'vocab-review-done';


let entries = [];
let leechWords = [];
let scoreRecords = [];
let scoreChartInstance = null;
let deviationChartInstance = null;
let refEntries = []; // 参考書の予定を保存する配列
// ── スケジュール編集モード管理用（単語） ─────────────────────
let editingEntryId = null;        // 現在編集中の単語エントリID（nullなら新規追加モード）
let entryFormSnapshot = null;      // 編集開始前のフォーム内容（キャンセル時に復元）
// ── スケジュール編集モード管理用（参考書） ───────────────────
let editingRefEntryId = null;      // 現在編集中の参考書エントリID（nullなら新規追加モード）
let refFormSnapshot = null;        // 編集開始前のフォーム内容（キャンセル時に復元）
let reviewDoneSet = new Set(); // クリア済みの復習項目キーの集合
// 日別進捗記録: [{ id, date, entryId, type:'word'|'book', plannedStart, plannedEnd, actualEnd, bookName? }]
let dailyProgress = [];

// ── ストレージ共通ヘルパー ────────────────────────────────────
function loadFromStorage(key, fallback = []) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch(e) { return fallback; }
}
function saveToStorage(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); }
  catch(e) { console.error('Storage error:', e); }
}
// ──────────────────────────────────────────────────────────────

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
// ──────────────────────────────────────────────────────────────

// ── STEP 8：統一バッジ生成ヘルパー ────────────────────────────

/**
 * 「未完了繰越」バッジのHTMLを返す（テーブルビュー・カードビュー共通）
 * @param {string|null} originalDate - 元の予定日（'YYYY-MM-DD'）。なければ省略表示
 * @param {string} [cls='carry-badge'] - 付与するクラス名
 */
function buildCarryBadgeHtml(originalDate, cls = 'carry-badge') {
  const datePart = originalDate ? ` [${originalDate}]` : '';
  return `<span class="${cls}" style="background:#fff7ed;color:#9a3412;border-color:#fed7aa;">⚠️ 未完了繰越${datePart}</span>`;
}

/**
 * 「復習」バッジのHTMLを返す（テーブルビュー・カードビュー共通）
 * @param {number} interval    - 復習インターバル日数（1/3/7/14 等）
 * @param {number} delayedDays - 遅れ日数（0 なら遅れなし）
 * @param {'inline'|'block'}  [layout='inline'] - 'block' ならラベルをブロック要素で包む
 */
function buildReviewBadgeHtml(interval, delayedDays, layout = 'inline') {
  const tier = getIntervalTier(interval);
  const ts = getIntervalTierStyle(interval);
  // 🔁 復習 Lv.X [N日後]
  const mainBadge = `<span style="display:inline-flex;align-items:center;gap:3px;background:${ts.bg};color:${ts.color};border:1px solid ${ts.border};border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;white-space:nowrap;">🔁 復習 Lv.${tier} [${interval}日後]</span>`;
  // 🔄 [遅れN日]（遅れがある場合のみ）
  const delayBadge = delayedDays > 0
    ? `<span style="display:inline-flex;align-items:center;background:#b23a2e;color:#fff;border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;white-space:nowrap;">🔄 [遅れ${delayedDays}日]</span>`
    : '';
  return `${mainBadge}${delayBadge ? ' ' + delayBadge : ''}`;
}
// ──────────────────────────────────────────────────────────────

function pad(n){ return String(n).padStart(2,'0'); }
function formatISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function parseISO(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function addDays(d, n){ const nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; }
function todayISO(){ return formatISO(new Date()); }

/**
 * fromDate から intervalDays 日後以降で、
 * reviewWeekdays に一致する最初の日付を返す。
 * reviewWeekdays が空なら従来通り固定日数で返す。
 * @param {string} fromDate        - 'YYYY-MM-DD' 形式の起点日
 * @param {number} intervalDays    - 加算する日数（DEFAULT_INTERVALS の値）
 * @param {number[]} reviewWeekdays - 許可する曜日の配列（0=日〜6=土）
 * @returns {string} 'YYYY-MM-DD' 形式の復習日
 */
function findNextReviewWeekday(fromDate, intervalDays, reviewWeekdays) {
  const base = addDays(parseISO(fromDate), intervalDays);
  if (!reviewWeekdays || reviewWeekdays.length === 0) {
    return formatISO(base); // フォールバック：従来動作
  }
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(base, i);
    if (reviewWeekdays.includes(candidate.getDay())) {
      return formatISO(candidate);
    }
  }
  return formatISO(base); // 念のためフォールバック
}

/* ---------- 復習の完了チェック／遅れた分だけ1日ずつずらすロジック ---------- */

// 復習項目1件ごとに一意なキーを作る（単語range／参考書rangeごと・間隔日数ごとに固定）
function buildReviewKey(prefix, ownerId, rangeStart, rangeEnd, interval){
  return `${prefix}_${ownerId}_${rangeStart}_${rangeEnd}_${interval}`;
}

function loadReviewDone(){
  reviewDoneSet = new Set(loadFromStorage(REVIEW_DONE_KEY, []));
}
function saveReviewDone(){
  saveToStorage(REVIEW_DONE_KEY, Array.from(reviewDoneSet));
}

// 本来の復習予定日(originalIso)と完了状態から、「実際に表示すべき復習日」を求める。
// ルール：予定日を過ぎてもクリアしていない項目は、次の復習曜日（reviewWeekdays 指定がなければ今日）に移動する。
// 移動先の日付をキーに埋め込んだ movedKey を返すことで、移動のたびにチェック状態がリセットされる。
// 予定日が来ていない、またはすでにクリア済みの項目はずらさない。
function computeEffectiveReviewDate(originalIso, key, reviewWeekdays){
  // 【バグ2修正】進捗パネル(dailyProgress)に完了記録があるかチェック
  // reviewDoneSet はカレンダーのチェックボックス経由でのみ更新されるため、
  // パネルから完了させた場合に done: true にならないケースに対応する。
  // ★ movedKey 対応：dailyProgress には movedKey（例: key_moved_YYYY-MM-DD）が
  //    保存されるため、originalKey との完全一致だけでなく
  //    p.reviewKey.replace(/_moved_.*/, '') === key でも照合する。
  // ★【バグ3修正】p.date <= originalIso フィルターを追加。
  //    moved 完了後の残存レコード（p.date > originalIso）が、同一 base key を持つ
  //    別サイクルの復習を誤って「完了済み」と判定するのを防ぐ。
  //    moved 完了は line 1735 の reviewDoneSet.add(baseKey) で確実に記録されるため、
  //    isDoneInPanel は originalIso 以前のレコードのみ対象とすれば十分。
  const isDoneInPanel = dailyProgress.some(p =>
    (p.type === 'word-review' || p.type === 'book-review') &&
    p.reviewKey != null && (p.reviewKey === key || p.reviewKey.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '') === key) &&
    p.date <= originalIso &&
    !p.notProgressed &&
    p.actualEnd >= p.plannedEnd
  );

  if(reviewDoneSet.has(key) || isDoneInPanel){
    return { date: originalIso, delayedDays: 0, done: true };
  }
  const todayIso  = todayISO();
  const diffDays  = Math.round(
    (parseISO(todayIso) - parseISO(originalIso)) / 86400000
  );
  if(diffDays <= 0){
    // まだ予定日が来ていない、またはちょうど今日が予定日
    return { date: originalIso, delayedDays: 0, done: false };
  }

  // ★ 遅れた場合：次の復習曜日に移動（reviewWeekdays 未指定時は今日）
  const newDate = reviewWeekdays && reviewWeekdays.length > 0
    ? findNextReviewWeekday(originalIso, diffDays, reviewWeekdays)
    : todayIso;

  // ★ 移動先の日付をキーに埋め込むことで、移動毎にチェック状態をリセット
  const movedKey = `${key}_moved_${newDate}`;

  return { date: newDate, movedKey, delayedDays: diffDays, done: false };
}

// オリジナル計画チャンクから復習リストを生成する共通ヘルパー（単語・参考書共用）。
// chunks  : フィルタ済みチャンク配列
// prefix  : キー接頭辞（'w' or 'r'）
// getOwnerId  : chunk → ownerID（entryId or planId）
// getWeekdays : chunk → reviewWeekdays 配列
// getIntervals: chunk → インターバル日数配列
// extraFields : chunk → pushするオブジェクトに追加するフィールド
function buildReviewsFromChunks(chunks, prefix, getOwnerId, getWeekdays, getIntervals, extraFields) {
  const raw = [];
  chunks.forEach(c => {
    (getIntervals(c) || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(c.date), n));
      const key = buildReviewKey(prefix, getOwnerId(c), c.rangeStart, c.rangeEnd, n);
      const eff = computeEffectiveReviewDate(originalDate, key, getWeekdays(c));
      raw.push({ date: eff.date, originalDate, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd,
        interval: n, key: eff.movedKey ?? key, delayedDays: eff.delayedDays, done: eff.done,
        ...extraFields(c) });
    });
  });
  return raw;
}

// 進捗記録ベースの復習リストを生成する共通ヘルパー（単語・参考書共用）。
// progressItems : フィルタ済み dailyProgress 配列
// prefix        : キー接頭辞（'w' or 'r'）
// getResolved   : p → resolvedId（entryId/planId）
// getEntity     : resolvedId → entries/refEntries の該当エントリ
// getIntervals  : entity → インターバル日数配列
// extraFields   : (p, resolved, entity) → 追加フィールド
function buildProgressReviews(progressItems, prefix, getResolved, getEntity, getIntervals, extraFields) {
  const raw = [];
  progressItems.forEach(p => {
    const resolved = getResolved(p);
    const entity = getEntity(resolved);
    if (!entity) return;
    const reviewWeekdays = entity.reviewWeekdays || [];
    (getIntervals(entity) || []).forEach(n => {
      const originalDate = findNextReviewWeekday(p.date, n, reviewWeekdays);
      const key = `${prefix}_prog_${resolved}_${p.date}_${p.plannedStart}_${n}`;
      const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
      raw.push({
        date: eff.date, originalDate, rangeStart: p.plannedStart, rangeEnd: p.actualEnd,
        interval: n, key: eff.movedKey ?? key, delayedDays: eff.delayedDays, done: eff.done,
        ...extraFields(p, resolved, entity)
      });
    });
  });
  return raw;
}

// 単語・参考書の全復習項目（本来の日付＋ずらし後の実効日付）をまとめて計算する共通関数。
// renderMergedSchedule / renderIntegratedSchedule の両方から呼ばれる。
// ★ 進捗記録がある場合は computeAdjustedChunksForEntry / computeAdjustedRefSchedule を使い
//   残りのスケジュールを自動再配分する。
function buildAllReviews(){
  // ─── 単語 ─────────────────────────────────────────────────────────────
  const vocabChunks = entries.flatMap(computeAdjustedChunksForEntry);

  // 進捗記録済み・繰り越しチャンクを除外してからヘルパーへ渡す
  // composite key でも照合（繰り越し後に入力したケースに対応）
  const filteredVocabChunks = vocabChunks.filter(c => {
    if (c.isFromProgress) return false;
    const chunkKey = `${c.entryId}_${c.date}_${c.rangeStart}`;
    return !dailyProgress.some(p => {
      if (p.type !== 'word') return false;
      if (p.originEntryId != null) return p.entryId === chunkKey; // 新形式
      return p.date === c.date && p.entryId === c.entryId && p.rangeStart === c.rangeStart; // 旧形式
    });
  });

  const rawVocabReviews = [
    ...buildReviewsFromChunks(
      filteredVocabChunks, 'w',
      c => c.entryId,
      c => entries.find(e => e.id === c.entryId)?.reviewWeekdays || [],
      c => c.intervals,
      c => ({ entryId: c.entryId })
    ),
    ...buildProgressReviews(
      dailyProgress.filter(p => p.type === 'word' && !p.notProgressed),
      'w',
      p => p.originEntryId || p.entryId,
      id => entries.find(e => e.id === id),
      entity => entity.intervals || DEFAULT_INTERVALS,
      (p, resolved) => ({ entryId: resolved })
    ),
  ];

  // ─── 参考書 ────────────────────────────────────────────────────────────
  const refChunks = refEntries.flatMap(plan =>
    computeAdjustedRefSchedule(plan).map(c => ({ ...c, bookName: plan.bookName, planId: plan.id }))
  );

  // 進捗記録済み・繰り越しチャンクを除外してからヘルパーへ渡す
  const filteredRefChunks = refChunks.filter(c => {
    if (c.isFromProgress) return false;
    const chunkKey = `${c.planId}_${c.date}_${c.rangeStart}`;
    return !dailyProgress.some(p => {
      if (p.type !== 'book') return false;
      if (p.planId && p.planId !== p.entryId) return p.entryId === chunkKey; // 新形式
      return p.date === c.date && (p.planId || p.entryId) === c.planId;      // 旧形式
    });
  });

  const rawRefReviews = [
    ...buildReviewsFromChunks(
      filteredRefChunks, 'r',
      c => c.planId,
      c => refEntries.find(r => r.id === c.planId)?.reviewWeekdays || [],
      () => DEFAULT_INTERVALS,
      c => ({ bookName: c.bookName, planId: c.planId })
    ),
    ...buildProgressReviews(
      dailyProgress.filter(p => p.type === 'book' && !p.notProgressed),
      'r',
      p => p.planId || p.entryId,
      id => refEntries.find(r => r.id === id),
      () => DEFAULT_INTERVALS,
      (p, resolved, entity) => ({ bookName: entity.bookName, planId: resolved })
    ),
  ];

  // 【修正】一意な key を基準に重複した復習タスクを除外
  const vocabReviews = Array.from(
    new Map(rawVocabReviews.map(r => [r.key, r])).values()
  );
  const refReviews = Array.from(
    new Map(rawRefReviews.map(r => [r.key, r])).values()
  );

  return { vocabChunks, refChunks, vocabReviews, refReviews };
}

/**
 * チャンク配列から未達成の繰り上げリストを生成する共通ヘルパー。
 * @param {Object[]} chunks      - 元チャンク配列（vocabChunks / refChunks）
 * @param {'word'|'book'} type   - 種別（getLatestProgress の type 引数に対応）
 * @param {function} hasRecordFn - chunk を受け取り「進捗記録あり」なら true を返すコールバック
 * @returns {Object[]} 今日付けに繰り上げたチャンク配列
 */
function buildCarryForwardList(chunks, type, hasRecordFn) {
  const todayStr = todayISO();
  return chunks
    .filter(c => c.date < todayStr)
    .filter(c => {
      const latest = getLatestProgress(type === 'word' ? c.entryId : c.planId, type);
      if (latest && latest.actualEnd >= c.rangeEnd) return false;
      return !hasRecordFn(c);
    })
    .map(c => ({ ...c, date: todayStr, carriedForward: true, originalDate: c.date }));
}

/**
 * 過去日付のうち未達成のチャンクを今日に繰り上げて返す。
 *
 * 判定ルール（単語・参考書共通）:
 * 1. 最新の進捗記録の actualEnd がこのチャンクの rangeEnd 以上 → 完了とみなしスキップ
 * 2. このチャンクの元日付に対して progress 記録がある → 残量は computeAdjusted* で再配分済みのためスキップ
 * 3. 上記どちらも該当しない → 未達成として今日 (todayISO) に繰り上げ
 */
function getCarryForwardChunks(vocabChunks, refChunks) {
  // ★ composite key 新形式（originEntryId）・旧形式（entryId）の両方に対応
  const cfVocab = buildCarryForwardList(vocabChunks, 'word', chunk => {
    const chunkKey = `${chunk.entryId}_${chunk.date}_${chunk.rangeStart}`;
    return dailyProgress.some(p => {
      if (p.type !== 'word' || p.notProgressed) return false;
      // 新形式（originEntryId が存在する）は複合キーで完全一致のみ
      if (p.originEntryId != null) return p.entryId === chunkKey;
      // 旧形式：日付とエントリーIDで照合
      return p.date === chunk.date && p.entryId === chunk.entryId;
    });
  });

  // 複合キー（chunkKey）を生成し、p.entryId と照合するロジックを追加
  const cfRef = buildCarryForwardList(refChunks, 'book', chunk => {
    const chunkKey = `${chunk.planId}_${chunk.date}_${chunk.rangeStart}`;
    return dailyProgress.some(p => {
      if (p.type !== 'book' || p.notProgressed) return false;
      // 新形式（planId が entryId と異なる = entryId が複合キー）は完全一致のみ
      if (p.planId && p.planId !== p.entryId) return p.entryId === chunkKey;
      // 旧形式：日付とプランIDで照合
      if (p.date === chunk.date) {
        return (p.planId || p.entryId) === chunk.planId;
      }
      return false;
    });
  });

  return { cfVocab, cfRef };
}

/**
 * 繰り上げ（carry-forward）されたチャンクに紐づく復習日を、新しい学習日基準に再計算する。
 * 繰り上げ前の学習日から算出された復習予定は削除し、繰り上げ後の日付 + インターバルで再生成する。
 */
function isReviewFromOriginalSchedule(review, cfChunk, type) {
  const ownerId = type === 'word' ? cfChunk.entryId : cfChunk.planId;
  const prefix = type === 'word' ? 'w' : 'r';
  const expectedKey = buildReviewKey(prefix, ownerId, cfChunk.rangeStart, cfChunk.rangeEnd, review.interval);
  
  // 変更点: 完全一致だけでなく、移動済みのキー(_moved_)も判定に含める
  const reviewBaseKey = review.key.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '');
  if (reviewBaseKey !== expectedKey) return false;
  
  const expectedOriginal = formatISO(addDays(parseISO(cfChunk.originalDate), review.interval));
  return review.originalDate === expectedOriginal;
}


function addReviewsFromCf(cfList, prefix, filteredReviews, getOwnerId, getWeekdays, getIntervals, extraFields) {
  cfList.forEach(c => {
    (getIntervals(c) || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(c.date), n));
      const key = buildReviewKey(prefix, getOwnerId(c), c.rangeStart, c.rangeEnd, n);
      const eff = computeEffectiveReviewDate(originalDate, key, getWeekdays(c));
      filteredReviews.push({ date: eff.date, originalDate, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd,
        interval: n, key: eff.movedKey ?? key, delayedDays: eff.delayedDays, done: eff.done,
        ...extraFields(c) });
    });
  });
}

function adjustReviewsForCarryForward(vocabReviews, refReviews, cfVocab, cfRef) {
  const filteredVocabReviews = vocabReviews.filter(r =>
    !cfVocab.some(cf => isReviewFromOriginalSchedule(r, cf, 'word'))
  );
  // ★ 修正：参考書もオリジナル計画ベースの復習を持つため、cfRef で古い復習を除去する
  const filteredRefReviews = refReviews.filter(r =>
    !cfRef.some(cf => isReviewFromOriginalSchedule(r, cf, 'book'))
  );

  addReviewsFromCf(cfVocab, 'w', filteredVocabReviews,
    c => c.entryId,
    c => entries.find(e => e.id === c.entryId)?.reviewWeekdays || [],
    c => c.intervals,
    c => ({ entryId: c.entryId })
  );

  // ★ 修正：cfRef の繰越チャンクから新しい日付基準で復習を再生成（単語の cfVocab と対称）
  addReviewsFromCf(cfRef, 'r', filteredRefReviews,
    c => c.planId,
    c => refEntries.find(r => r.id === c.planId)?.reviewWeekdays || [],
    () => DEFAULT_INTERVALS,
    c => ({ bookName: c.bookName, planId: c.planId })
  );

  return { vocabReviews: filteredVocabReviews, refReviews: filteredRefReviews };
}

/**
 * スケジュール描画用の共通データ（チャンク・繰り上げ・復習調整済み）をまとめて返す。
 */
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

// 復習チェックボックスにクリックイベントを設定する共通関数。
// チェック/解除のたびに保存し、全スケジュール表示を再描画する。
function attachReviewCheckHandlers(container){
  if(!container) return;
  container.querySelectorAll('.review-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      // 【Bug 1 修正】期限超過で日付移動した復習項目のキーは movedKey（例: `originalKey_moved_YYYY-MM-DD`）になっている。
      // computeEffectiveReviewDate は originalKey（サフィックスなし）で reviewDoneSet を照合するため、
      // ここで _moved_YYYY-MM-DD サフィックスを除去した originalKey をセットに保存することでミスマッチを解消する。
      const originalKey = key.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '');
      if(cb.checked){ reviewDoneSet.add(originalKey); } else { reviewDoneSet.delete(originalKey); }
      saveReviewDone();
      refreshAllSchedules();
      renderIntegratedSchedule();
      renderRefTodayCard(); // 参考書「今日やること」カードを同期更新
    });
  });
}

/* ---------- 日別進捗（保存・読み込み） ---------- */
function loadDailyProgress() {
  dailyProgress = loadFromStorage(DAILY_PROGRESS_KEY);
}
function saveDailyProgress() {
  saveToStorage(DAILY_PROGRESS_KEY, dailyProgress);
}

/**
 * 特定エントリ・日付の進捗レコードを返す（最新1件）
 * book タイプの場合は planId でも照合する（後方互換 + 新形式の両方に対応）
 */
function getLatestProgress(entryId, type) {
  const records = dailyProgress
    .filter(p => {
      if (p.type !== type) return false;
      if (p.notProgressed) return false; // ★「進んでいない」レコードは再計算の起点から除外
      if (type === 'book') {
        // planId が一致、または entryId が一致（後方互換）、または entryId が planId で始まる（複合キー）
        const resolvedPlanId = p.planId || p.entryId;
        return resolvedPlanId === entryId || p.entryId === entryId;
      }
      // word: originEntryId（composite key 新形式）または entryId（旧形式）で照合
      return (p.originEntryId || p.entryId) === entryId;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.actualEnd - a.actualEnd);
  return records[0] || null;
}

// 翌学習日を求めるヘルパー（fromDate の翌日以降で weekdays に一致する最初の日を返す）
function findNextStudyDay(fromDate, weekdays) {
  // weekdays が空（未設定・毎日学習）の場合は翌日をそのまま返す
  if (!weekdays || weekdays.length === 0) {
    return formatISO(addDays(parseISO(fromDate), 1));
  }
  for (let i = 1; i <= 14; i++) {
    const d = addDays(parseISO(fromDate), i);
    if (weekdays.includes(d.getDay())) return formatISO(d);
  }
  return formatISO(addDays(parseISO(fromDate), 1)); // フォールバック
}

// ── 教材種別ごとの差分を設定オブジェクトに集約 ──────────────────────────
// 「単語」と「参考書」で異なる箇所はここだけに閉じ込め、計算ループは共通化する
const MATERIAL_CONFIGS = {
  word: {
    type: 'word',
    computeBaseSchedule: (material) => computeChunksForEntry(material),
    filterProgress: (materialId) => dailyProgress.filter(p =>
      p.type === 'word' &&
      !p.notProgressed &&
      (p.originEntryId || p.entryId) === materialId
    ),
    // チャンクに付与する種別固有のフィールド（entryId + 復習インターバル）
    chunkIdFields: (material) => ({ entryId: material.id, intervals: material.intervals }),
  },
  book: {
    type: 'book',
    computeBaseSchedule: (material) => computeRefSchedule(material),
    filterProgress: (materialId) => dailyProgress.filter(p =>
      p.type === 'book' &&
      !p.notProgressed &&
      (p.planId === materialId || p.entryId === materialId)
    ),
    // チャンクに付与する種別固有のフィールド（planId のみ）
    chunkIdFields: (material) => ({ planId: material.id }),
  },
};

/**
 * 進捗記録を考慮してチャンクを再計算する（単語・参考書共通）
 * @param {'word'|'book'} materialType - 教材の種別
 * @param {Object}        material     - entry（単語）または plan（参考書）
 */
function computeAdjustedSchedule(materialType, material) {
  const cfg = MATERIAL_CONFIGS[materialType];
  const latest = getLatestProgress(material.id, cfg.type);
  if (!latest) return cfg.computeBaseSchedule(material);

  const originalChunks = cfg.computeBaseSchedule(material);
  const idFields = cfg.chunkIdFields(material); // 種別固有フィールドを事前に取得

  // [Step 1] dailyProgressから実績のみ構築
  const pastChunks = cfg.filterProgress(material.id)
    .map(p => ({
      date: p.date,
      rangeStart: p.plannedStart,
      rangeEnd: p.actualEnd,
      ...idFields,
      isFromProgress: true
    }));

  // ▼ BUGFIX: todayStr を先に定義（futureChunks の基準として利用）
  const todayStr = todayISO();
  // ▼ BUGFIX Step 1: 基準を latest.date（進捗入力日）→ todayStr（今日）に変更
  //   過去の繰越タスクを「今日」入力しても latest.date が today になるため、
  //   c.date > latest.date では今日の元スケジュールが除外されてしまっていた。
  //   常に「明日以降」を未来分として扱うことで消失を防ぐ。
  const futureChunks = originalChunks.filter(c => c.date > todayStr);

  const remainingStart = latest.actualEnd + 1;
  // BUGFIX③: endNum が undefined/null の場合（古いデータ等）は 0 をガード値として使用し、
  //           NaN が後続処理（remaining 計算・while ループ）へ伝播するのを防ぐ。
  //           remainingEnd=0 のとき remaining<=0 が確実に true になり pastChunks を返す。
  const remainingEnd   = material.endNum ?? 0;
  const remaining      = remainingEnd - remainingStart + 1;

  if (remaining <= 0) return pastChunks; // 全完了

  // [Step 2] 今日の残キャパシティを確認し、未完了分を今日から順に割り当て
  // ▼ BUGFIX Step 2: 直近の進捗レコードの残量（latest.plannedEnd - latest.actualEnd）ではなく
  //   「元々今日に予定されていた originalChunks の量（remainingStart 以降の部分）」を基準にする。
  //   繰越タスクを完了した場合は latest.plannedEnd - latest.actualEnd = 0 になってしまい、
  //   今日の元スケジュール分がキャパとして計上されなかった。
  const todayOriginalChunks = originalChunks.filter(c => c.date === todayStr);
  const todayCapacity = todayOriginalChunks.reduce((sum, c) => {
    const effectiveStart = Math.max(c.rangeStart, remainingStart);
    return sum + Math.max(0, c.rangeEnd - effectiveStart + 1);
  }, 0);

  const todayChunks = [];
  let futureStart = remainingStart;

  if (todayCapacity > 0) {
    const todayCount = Math.min(todayCapacity, remaining);
    todayChunks.push({
      date: todayStr,
      rangeStart: remainingStart,
      rangeEnd: remainingStart + todayCount - 1,
      ...idFields,
      isAdjusted: true,
      isCarriedNew: false
    });
    futureStart = remainingStart + todayCount;
  }

  const futureRemaining = remainingEnd - futureStart + 1;
  if (futureRemaining <= 0) return [...pastChunks, ...todayChunks];

  // [Step 3] 将来チャンクがない場合：新規タスクを生成して配分
  if (futureChunks.length === 0 || material.planMode === 'byAmount') {
    const amountPerDay = Math.max(1,
      material.planMode === 'byAmount'
        ? material.amountPerDay
        : originalChunks.length > 0
          ? Math.ceil((material.endNum - material.startNum + 1) / originalChunks.length)
          : futureRemaining
    );

    const newChunks = [];
    let cursor = futureStart;
    let searchFrom = todayStr;
    let safety = 0;
    while (cursor <= remainingEnd && safety++ < 3650) {
      // weekdays が空（未設定）の場合は毎日学習として全曜日を渡す（空配列チェックの安全ガード）
      const effectiveWeekdays = (material.weekdays && material.weekdays.length > 0)
        ? material.weekdays
        : [0, 1, 2, 3, 4, 5, 6];
      const nextDate = findNextStudyDay(searchFrom, effectiveWeekdays);
      const count = Math.min(amountPerDay, remainingEnd - cursor + 1);
      newChunks.push({
        date: nextDate,
        rangeStart: cursor,
        rangeEnd: cursor + count - 1,
        ...idFields,
        isAdjusted: true,
        isCarriedNew: newChunks.length === 0 && todayChunks.length === 0
      });
      cursor += count;
      searchFrom = nextDate;
    }
    return [...pastChunks, ...todayChunks, ...newChunks];
  }

  // [Step 4] 将来チャンクに残量を均等配分
  const base   = Math.floor(futureRemaining / futureChunks.length);
  const rem    = futureRemaining % futureChunks.length;
  let cursor   = futureStart;

  const newFutureChunks = futureChunks.flatMap((c, idx) => {
    const count      = base + (idx < rem ? 1 : 0);
    if (count <= 0) return []; // futureRemaining < futureChunks.length 時の不正チャンク防止
    const rangeStart = cursor;
    const rangeEnd   = cursor + count - 1;
    cursor = rangeEnd + 1;
    return [{ ...c, rangeStart, rangeEnd, isAdjusted: true,
              isCarriedNew: idx === 0 && todayChunks.length === 0 }];
  });

  return [...pastChunks, ...todayChunks, ...newFutureChunks];
}

// ── 後方互換ラッパー：既存の呼び出し元（buildAllReviews等）を変更ゼロに保つ ──
function computeAdjustedChunksForEntry(entry) { return computeAdjustedSchedule('word', entry); }
function computeAdjustedRefSchedule(plan)     { return computeAdjustedSchedule('book', plan); }

/**
 * 全完了した場合の残り日数を計算（進捗が良い場合の通知用）
 * returns: 何日早く終わるか（0以下なら早まらない）
 */
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

// チップ群（曜日・インターバル）に既存の値を反映させる（編集モードでフォームへ復元する用）
function setCheckedValues(rowId, values = []) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const isChecked = values.includes(Number(cb.value));
    cb.checked = isChecked;
    cb.closest('.chip')?.classList.toggle('checked', isChecked);
  });
}

async function loadEntries(){
  entries = loadFromStorage(STORAGE_KEY);
}
async function saveEntries(){
  saveToStorage(STORAGE_KEY, entries);
}

/**
 * byAmount / byRange 両モード共通のチャンク生成コア。
 * extraFields に含めたいフィールドをオブジェクトで渡す（スプレッドで各チャンクにマージ）。
 */
function computeScheduleChunks(plan, extraFields = {}) {
  const start = parseISO(plan.startDate);
  const chunks = [];
  if (plan.planMode === 'byAmount') {
    let cursor = plan.startNum, daysAdded = 0;
    while (cursor <= plan.endNum && daysAdded <= 3650) {
      const d = addDays(start, daysAdded++);
      if (!(plan.weekdays || []).includes(d.getDay())) continue;
      const count = Math.min(plan.amountPerDay, plan.endNum - cursor + 1);
      chunks.push({ date: formatISO(d), rangeStart: cursor, rangeEnd: cursor + count - 1, ...extraFields });
      cursor += count;
    }
  } else {
    // 過去のデータ（終了日が未設定のもの）は開始日から1週間とするための安全措置
    const end = plan.endDate ? parseISO(plan.endDate) : addDays(start, 6);
    const studyDates = [];
    let cur = new Date(start);
    while (cur <= end && studyDates.length <= 3650) {
      if ((plan.weekdays || []).includes(cur.getDay())) studyDates.push(new Date(cur));
      cur = addDays(cur, 1);
    }
    if (!studyDates.length) return [];
    const base = Math.floor((plan.endNum - plan.startNum + 1) / studyDates.length);
    const rem  = (plan.endNum - plan.startNum + 1) % studyDates.length;
    let cursor = plan.startNum;
    studyDates.forEach((d, idx) => {
      const count = base + (idx < rem ? 1 : 0);
      if (count <= 0) return;
      chunks.push({ date: formatISO(d), rangeStart: cursor, rangeEnd: cursor + count - 1, ...extraFields });
      cursor += count;
    });
  }
  return chunks;
}

function computeChunksForEntry(entry) {
  return computeScheduleChunks(entry, { entryId: entry.id, intervals: entry.intervals });
}
function computeRefSchedule(plan) {
  return computeScheduleChunks(plan, { intervals: plan.intervals || [] });
}

function renderEntryList(){
  const list = document.getElementById('entryList');
  if(!list) return;
  list.innerHTML = '';
  if(entries.length === 0) return;
  entries.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'entry-item';
    const wdLabel = (entry.weekdays || []).slice().sort((a,b)=>a-b).map(i=>WEEKDAYS[i]).join('・');
    
    // 期間の表示をスマートに分岐
    let modeText = '';
    if (entry.planMode === 'byAmount') {
      modeText = `開始日 ${entry.startDate} (1日${entry.amountPerDay}単語)`;
    } else {
      modeText = entry.endDate ? `${entry.startDate} 〜 ${entry.endDate}` : `開始日 ${entry.startDate} (1週間)`;
    }

    item.classList.toggle('is-editing', entry.id === editingEntryId);
    item.innerHTML = `
      <div>
        <span class="rng">${entry.startNum}〜${entry.endNum}</span>
        <div class="meta">${modeText} ／ 学習日: ${wdLabel} ／ 復習: ${(entry.intervals ?? []).join('・')}日後</div>
      </div>
      <div class="entry-actions">
        <button class="edit-btn" data-id="${entry.id}">編集</button>
        <button class="del-btn" data-id="${entry.id}">削除</button>
      </div>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => startEditEntry(btn.dataset.id));
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      // 編集中の項目が削除された場合は編集モードを解除しておく（不整合防止）
      if (editingEntryId === btn.dataset.id) exitEntryEditMode();
      entries = entries.filter(e => e.id !== btn.dataset.id);
      await saveEntries();
      renderAll();
    });
  });
}

// 単語スケジュールと参考書スケジュールをまとめて1つのカレンダーとして描画する共通関数
// 「単語タブ」の #scheduleArea に描画する（参考書タブは renderRefTodayCard で管理）
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

  // ── 過去の未達成チャンクは buildScheduleData 内で繰り上げ済み ──

  const today = new Date(); today.setHours(0,0,0,0);
  // 表示は「今日」以降のみ（過去日は非表示）
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
        // STEP 8: 未完了繰越バッジを統一形式で表示
        const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
        const cnBadge = c.isCarriedNew   ? buildCarryBadgeHtml(c.originalDate || null) : '';
        return `<span class="tag tag-new">${c.rangeStart}〜${c.rangeEnd}${cfBadge}${cnBadge}</span>`;
      }).join('') || '—'}</td>
      <td>${row.reviewItems.map(r => {
        // STEP 8: 復習バッジを統一形式で表示（🔁 復習 Lv.X [N日後] + 🔄 [遅れN日]）
        const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
        return `<label class="tag tag-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}><span class="stamp">◎</span>${reviewBadge} ${r.rangeStart}〜${r.rangeEnd}</label>`;
      }).join('') || '—'}</td>
      <td>${row.refItems.map(c => {
        // STEP 8: 参考書の未完了繰越バッジを統一形式で表示（carriedForward / isCarriedNew 両対応）
        const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
        const cnBadge = c.isCarriedNew   ? buildCarryBadgeHtml(c.originalDate || null) : '';
        return `<span class="tag tag-ref">${escapeHtml(c.bookName)} ${c.rangeStart}〜${c.rangeEnd}${cfBadge}${cnBadge}</span>`;
      }).join('') || '—'}</td>
      <td>${row.refReviewItems.map(r => {
        // STEP 8: 参考書復習バッジを統一形式で表示
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
  // refScheduleOutput は削除済み（参考書タブは renderRefTodayCard で管理）
}

function renderIntegratedSchedule() {
  const container = document.getElementById('integratedScheduleList');
  if (!container) return;
  const wasFutureOpen = document.getElementById('integratedScheduleFuture')?.open;
  container.innerHTML = '';

  // ── 凡例を先頭に挿入 ──────────────────────────────────────────
  container.insertAdjacentHTML('beforeend', reviewLegendHTML());
  // ─────────────────────────────────────────────────────────────

  // 表示日数の決定 (1週間なら7日、1ヶ月なら30日)
  const checked = document.querySelector('input[name="schedulePeriod"]:checked');
  const periodMode = checked ? checked.value : 'week';
  const targetDays = periodMode === 'week' ? 7 : 30;

  // 単語・参考書の新規チャンクと、復習日（繰り上げ時は自動調整済み）をまとめて取得
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
      // STEP 8: 未完了繰越バッジを統一形式で表示
      // 元の計画はバッジなし。carriedForward / isCarriedNew は ⚠️ 未完了繰越 [元日付]
      const carryBadge = w.carriedForward
        ? buildCarryBadgeHtml(w.originalDate)
        : (w.isCarriedNew ? buildCarryBadgeHtml(w.originalDate || null) : '');
      taskHtml += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"><span style="background:#e3f2fd;color:#0d47a1;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">単語</span>${carryBadge}<span style="color:#333;font-size:.85rem;">${w.rangeStart} 〜 ${w.rangeEnd}</span></div>`;
    });

    dayBooks.forEach(b => {
      // STEP 8: 参考書の未完了繰越バッジを統一形式で表示（carriedForward / isCarriedNew 両対応）
      const carryBadge = b.carriedForward
        ? buildCarryBadgeHtml(b.originalDate)
        : (b.isCarriedNew ? buildCarryBadgeHtml(b.originalDate || null) : '');
      taskHtml += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"><span style="background:#e8f5e9;color:#1b5e20;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">参考書</span>${carryBadge}<span style="color:#333;font-size:.85rem;">${escapeHtml(b.bookName)}: ${b.rangeStart} 〜 ${b.rangeEnd}</span></div>`;
    });

    dayWordReviews.forEach(r => {
      // STEP 8: 復習バッジを統一形式で表示
      // 通常: 🔁 復習 Lv.X [N日後]  /  移動済み: 🔁 復習 Lv.X [N日後] + 🔄 [遅れN日]
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      taskHtml += `<div style="margin-top:6px;max-width:100%;overflow:hidden;"><label style="cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 9px;border-radius:6px;background:${ts.bg};border:1px solid ${ts.border};${r.done ? 'opacity:.5;text-decoration:line-through;' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''} style="margin:0;flex-shrink:0;">${reviewBadge}<span style="color:#333;font-size:.8rem;word-break:break-all;">単語 ${r.rangeStart}〜${r.rangeEnd}</span></label></div>`;
    });

    dayBookReviews.forEach(r => {
      // STEP 8: 参考書復習バッジを統一形式で表示
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      taskHtml += `<div style="margin-top:6px;max-width:100%;overflow:hidden;"><label style="cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 9px;border-radius:6px;background:${ts.bg};border:1px solid ${ts.border};${r.done ? 'opacity:.5;text-decoration:line-through;' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''} style="margin:0;flex-shrink:0;">${reviewBadge}<span style="color:#333;font-size:.8rem;word-break:break-all;">${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}</span></label></div>`;
    });

    if (taskHtml === '') {
      taskHtml = `<div style="color: #999; font-size: 0.85rem; margin-top: 4px;">予定なし</div>`;
    }

    // 進捗入力UIの対象チャンクを i===0 のときのみ算出（HTML生成・イベント設定の両方で共用）
    const dayWordsForProgress       = i === 0 ? allWordChunks.filter(c => c.date.startsWith(dateStr)) : null;
    // 繰り越し分も含めた allBookChunks を使うことで、繰り越し参考書も進捗入力対象にする
    const dayBooksForProgress       = i === 0 ? allBookChunks.filter(c => c.date.startsWith(dateStr)) : null;
    // 未完了の復習タスクも進捗入力対象にする
    const dayWordReviewsForProgress = i === 0 ? dayWordReviews.filter(r => !r.done) : null;
    const dayBookReviewsForProgress = i === 0 ? dayBookReviews.filter(r => !r.done) : null;
    const hasAnyTask = i === 0 && (
      dayWordsForProgress.length > 0 || dayBooksForProgress.length > 0 ||
      dayWordReviewsForProgress.length > 0 || dayBookReviewsForProgress.length > 0
    );

    let progressSectionHtml = '';
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

    const hasCFWords  = i === 0 && dayWords.some(w => w.carriedForward);
    const hasCFBooks  = i === 0 && dayBooks.some(b => b.carriedForward);
    const hasCNWords  = i === 0 && dayWords.some(w => w.isCarriedNew);
    const hasCNBooks  = i === 0 && dayBooks.some(b => b.isCarriedNew); // ★参考書の isCarriedNew も繰越バナー対象
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

    if (hasAnyTask) {
      attachProgressInputHandlers(dayCard, dateStr);
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
}

/* ---------- 月目標カード ---------- */
function loadMonthGoal() {
  return loadFromStorage(MONTH_GOAL_KEY, { text: '' });
}
function saveMonthGoal(text) {
  saveToStorage(MONTH_GOAL_KEY, { text });
}
function renderMonthGoalCard() {
  const displayEl = document.getElementById('monthGoalDisplay');
  const inputEl = document.getElementById('monthGoalInput');
  if (!displayEl) return;
  const goal = loadMonthGoal();
  const text = (goal && goal.text) ? goal.text.trim() : '';
  displayEl.textContent = text ? text : '目標が設定されていません。「編集」から入力してください。';
  if (inputEl) inputEl.value = text;
}
function openMonthGoalEditor() {
  const displayEl = document.getElementById('monthGoalDisplay');
  const editArea = document.getElementById('monthGoalEditArea');
  const inputEl = document.getElementById('monthGoalInput');
  if (!editArea) return;
  const goal = loadMonthGoal();
  if (inputEl) inputEl.value = (goal && goal.text) ? goal.text : '';
  if (displayEl) displayEl.style.display = 'none';
  editArea.style.display = 'block';
  if (inputEl) inputEl.focus();
}
function closeMonthGoalEditor() {
  const displayEl = document.getElementById('monthGoalDisplay');
  const editArea = document.getElementById('monthGoalEditArea');
  if (editArea) editArea.style.display = 'none';
  if (displayEl) displayEl.style.display = 'block';
}
function handleMonthGoalSave() {
  const inputEl = document.getElementById('monthGoalInput');
  const text = inputEl ? inputEl.value.trim() : '';
  saveMonthGoal(text);
  renderMonthGoalCard();
  closeMonthGoalEditor();
}

/* ---------- 進捗入力 UI ---------- */

/**
 * 進捗入力コントロール（ボタン＋ステッパー方式）のHTMLを返すヘルパー
 * @param {number} rangeStart  - 計画開始番号/ページ
 * @param {number} rangeEnd    - 計画終了番号/ページ
 * @param {string|number} recordedVal - 既存の記録値（空文字 = 未記録）
 * @param {string} type        - 'word' | 'book' | 'word-review' | 'book-review'
 * @param {string} statusHtml  - 既存記録バッジのHTML
 * @param {string} inputAttrs  - hidden input に付与する data-* 属性の文字列
 */
function buildProgControlHtml(rangeStart, rangeEnd, recordedVal, type, statusHtml, inputAttrs) {
  const isWordType  = (type === 'word' || type === 'word-review');
  const unitWord    = isWordType ? '個' : 'ページ';
  const unitLabel   = isWordType ? '番まで' : 'ページまで';
  const plannedCount = rangeEnd - rangeStart + 1;

  const rv       = recordedVal !== '' ? parseInt(recordedVal, 10) : null;
  const isDone   = rv !== null && rv >= rangeEnd;
  const isNotProgressed = rv !== null && rv === rangeStart - 1;              // ★「進んでいない」状態
  const isPartial = rv !== null && rv > (rangeStart - 1) && rv < rangeEnd;  // ★ 境界値を > に変更（isNotProgressedと排他）
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
 * 復習セクション（単語・参考書共通）のHTMLを返す
 * @param {Array}  pendingReviews  - 未完了の復習タスク配列
 * @param {string} type            - 'word-review' | 'book-review'
 * @param {string} unit            - 単位文字列（'個' | 'ページ'）
 * @param {string} dividerLabel    - セクション見出し文字列
 * @param {string} dateStr         - 対象日付 (YYYY-MM-DD)
 * @param {Array}  existingRecords - 当日の既存進捗レコード
 * @returns {string} HTML文字列（タスクがなければ空文字）
 */
function buildReviewProgressItems(pendingReviews, type, unit, dividerLabel, dateStr, existingRecords) {
  if (!pendingReviews.length) return '';
  let html = `<div class="progress-review-divider">${dividerLabel}</div>`;
  pendingReviews.forEach(r => {
    const tier = getIntervalTier(r.interval);
    const rec  = existingRecords.find(p => p.reviewKey === r.key && p.type === type);
    const rv   = rec ? rec.actualEnd : '';
    const pc   = r.rangeEnd - r.rangeStart + 1;
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= r.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= r.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - r.rangeStart + 1}/${pc}${unit}`}
         </span>` : '';
    const badge = buildReviewBadgeHtml(r.interval, r.delayedDays);
    const nameLabel = type === 'word-review'
      ? `単語 ${r.rangeStart}〜${r.rangeEnd}（${pc}個）`
      : `${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}（${pc}ページ）`;
    const dataAttrs = type === 'word-review'
      ? `data-review-key="${r.key}" data-type="${type}" data-planned-start="${r.rangeStart}" data-planned-end="${r.rangeEnd}" data-date="${dateStr}"`
      : `data-review-key="${r.key}" data-type="${type}" data-planned-start="${r.rangeStart}" data-planned-end="${r.rangeEnd}" data-date="${dateStr}" data-book-name="${escapeHtml(r.bookName)}"`;
    html += `<div class="progress-item review-item t${tier}">
      <span class="progress-plan-label">${badge} ${nameLabel}</span>
      ${buildProgControlHtml(r.rangeStart, r.rangeEnd, rv, type, statusHtml, dataAttrs)}
    </div>`;
  });
  return html;
}

/**
 * 今日の単語・参考書チャンクに対する進捗入力セクションのHTMLを返す
 * @param {string} dateStr          - 対象日付 (YYYY-MM-DD)
 * @param {Array}  dayWords         - 当日の単語チャンク（新規）
 * @param {Array}  dayBooks         - 当日の参考書チャンク（新規・繰り越し含む）
 * @param {string} [baseId]         - IDプレフィックス（省略時は dateStr）
 * @param {Array}  [dayWordReviews] - 当日の単語復習タスク
 * @param {Array}  [dayBookReviews] - 当日の参考書復習タスク
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
    // ★ composite key：entryId + チャンク本来の日付 + 開始番号（同一単語帳の複数チャンク衝突防止）
    const chunkDate = w.carriedForward ? (w.originalDate || w.date) : w.date;
    const chunkKey  = `${w.entryId}_${chunkDate}_${w.rangeStart}`;

    const rec = existingRecords.find(p => p.entryId === chunkKey && p.type === 'word');
    const recordedVal = rec ? rec.actualEnd : '';
    const plannedCount = w.rangeEnd - w.rangeStart + 1;
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= w.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= w.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - w.rangeStart + 1}/${plannedCount}個完了`}
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
    // チャンクを一意に識別するキー: planId + チャンク本来の日付 + 開始ページ
    // 繰り越し分は originalDate、通常分は dateStr（= b.date）を使う
    const chunkOriginalDate = b.carriedForward ? (b.originalDate || b.date) : b.date;
    const chunkEntryId = `${planId}_${chunkOriginalDate}_${b.rangeStart}`;
    const rec = existingRecords.find(p => p.entryId === chunkEntryId && p.type === 'book');
    const recordedVal = rec ? rec.actualEnd : '';
    const plannedCount = b.rangeEnd - b.rangeStart + 1;
    // STEP 8: 未完了繰越バッジを統一形式で表示（carriedForward / isCarriedNew 両対応）
    const cfNote = b.carriedForward
      ? buildCarryBadgeHtml(b.originalDate)
      : (b.isCarriedNew ? buildCarryBadgeHtml(b.originalDate || null) : '');
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= b.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= b.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - b.rangeStart + 1}/${plannedCount}ページ完了`}
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

  // ── 復習：単語・参考書（共通ヘルパーで処理） ────────────────
  itemsHtml += buildReviewProgressItems(dayWordReviews.filter(r => !r.done), 'word-review', '個',   '🔁 復習タスク（単語）の進捗',   dateStr, existingRecords);
  itemsHtml += buildReviewProgressItems(dayBookReviews.filter(r => !r.done), 'book-review', 'ページ', '📚 復習タスク（参考書）の進捗', dateStr, existingRecords);

  // 新規・復習ともにタスクがなければ null を返す
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

/**
 * 進捗入力コントロール（ボタン＋ステッパー）のインタラクションをセットアップ
 */
function initProgressControls(container, dateStr, baseId) {
  baseId = baseId || dateStr;

  container.querySelectorAll('.prog-control-ui').forEach(ui => {
    const hiddenInput    = ui.querySelector('.progress-num-input');
    if (!hiddenInput) return;

    const btnDone           = ui.querySelector('.prog-btn-done');
    const btnPartial        = ui.querySelector('.prog-btn-partial');
    const btnNotProgressed  = ui.querySelector('.prog-btn-not-progressed'); // ★追加
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

    /* ── 表示を更新し、hidden input を更新してプレビューを起動 ── */
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

    /* ── ①ラベルの色をステップ状態に合わせて更新 ── */
    function updateStep1Label(mode) {
      if (!step1Label) return;
      step1Label.classList.toggle('step-done',          mode === 'done');
      step1Label.classList.toggle('step-partial',       mode === 'partial');
      step1Label.classList.toggle('step-not-progressed', mode === 'not-progressed'); // ★追加
    }

    /* ── ボタンのアクティブ状態を切り替える ── */
    function setActiveState(mode) {
      if (btnDone)           btnDone.classList.toggle('prog-btn-active',           mode === 'done');
      if (btnPartial)        btnPartial.classList.toggle('prog-btn-active',        mode === 'partial');
      if (btnNotProgressed)  btnNotProgressed.classList.toggle('prog-btn-active',  mode === 'not-progressed'); // ★追加
      if (partialPanel)      partialPanel.style.display = (mode === 'partial') ? 'block' : 'none';
      // 「途中まで」「進んでいない」どちらに切り替えても余剰パネルは閉じる
      if (extraPanel && mode !== 'done') extraPanel.style.display = 'none';
      updateStep1Label(mode);
    }

    /* ── 「✅ 完了」 ── */
    if (btnDone) {
      btnDone.addEventListener('click', () => {
        updateDisplay(rangeEnd);
        setActiveState('done');
        // ★ 余剰ページパネルを表示し、入力値を 0 にリセット
        if (extraPanel) {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          if (extraInput) extraInput.value = '0';
          extraPanel.style.display = 'block';
        }
      });
    }

    /* ── 余剰ページパネル ── */
    if (extraPanel) {
      // 「追加なし」→ パネルを閉じ、rangeEnd のまま確定
      const extraNoBtn = extraPanel.querySelector('.prog-extra-no-btn');
      if (extraNoBtn) {
        extraNoBtn.addEventListener('click', () => {
          extraPanel.style.display = 'none';
          // hiddenInput は既に rangeEnd なのでそのまま、プレビューだけ更新
          hiddenInput.dispatchEvent(new Event('input'));
        });
      }

      // ±ステッパー（余剰パネル専用。既存の .prog-step とクラス名が異なるため競合なし）
      extraPanel.querySelectorAll('.prog-extra-step').forEach(btn => {
        btn.addEventListener('click', () => {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          if (!extraInput) return;
          const delta   = parseInt(btn.dataset.delta, 10);
          const current = parseInt(extraInput.value, 10) || 0;
          extraInput.value = Math.max(0, current + delta);
        });
      });

      // 「✅ 記録」→ rangeEnd + 余剰ページ を hiddenInput に直接セット
      // ※ updateDisplay() のクランプ（+50上限）を迂回するため直接代入する
      const extraConfirmBtn = extraPanel.querySelector('.prog-extra-confirm-btn');
      if (extraConfirmBtn) {
        extraConfirmBtn.addEventListener('click', () => {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          const extraPages = Math.max(0, parseInt(extraInput?.value, 10) || 0);
          hiddenInput.value = rangeEnd + extraPages;
          hiddenInput.dispatchEvent(new Event('input')); // previewProgressAdjustment を起動
          extraPanel.style.display = 'none';
        });
      }
    }

    /* ── 「⚠️ 途中まで」 ── */
    if (btnPartial) {
      btnPartial.addEventListener('click', () => {
        // 現在が「完了」「進んでいない」または未入力なら、中間値を初期値にする
        const currentVal = parseInt(hiddenInput.value, 10);
        if (isNaN(currentVal) || currentVal >= rangeEnd || currentVal === rangeStart - 1) {
          const midVal = rangeStart - 1 + Math.max(1, Math.floor(plannedCount * 0.5));
          updateDisplay(Math.min(rangeEnd - 1, midVal));
        }
        setActiveState('partial');
        // パネルが開いたら入力フィールドにフォーカス
        if (progDisplayInput) {
          setTimeout(() => progDisplayInput.focus(), 50);
        }
      });
    }

    /* ── 「🚫 進んでいない」 ── */
    if (btnNotProgressed) {
      btnNotProgressed.addEventListener('click', () => {
        // hidden input に「0進捗」を示す番兵値（rangeStart - 1）をセット
        hiddenInput.value = rangeStart - 1;
        hiddenInput.dispatchEvent(new Event('input'));
        setActiveState('not-progressed');
      });
    }

    /* ── 直接入力フィールド ── */
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
          // 値に応じてボタン状態を自動切り替え
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
        // ブラー時に範囲外の値をクランプして同期
        const val = parseInt(hiddenInput.value, 10);
        if (!isNaN(val)) progDisplayInput.value = val;
      });
      // Enterキーで入力確定
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
  // 新UIのインタラクションもここで初期化
  initProgressControls(container, dateStr, baseId);
}

/**
 * 入力値を読みながら「進捗バナー」をリアルタイムプレビュー
 * @param {string} [baseId] - buildProgressInputSection に渡したものと同じベースID
 */
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

    // 復習タスクは「ページ/個数」のみ記録（繰り越し再調整は行わない）
    const isReview = type === 'word-review' || type === 'book-review';
    const unit = (type === 'word' || type === 'word-review') ? '個' : 'ページ';
    const prefix = isReview ? '復習 ' : '';
    const label = (type === 'word' || type === 'word-review')
      ? `${prefix}単語 ${plannedStart}〜${plannedEnd}`
      : `${prefix}${input.dataset.bookName || '参考書'} ${plannedStart}〜${plannedEnd}`;

    if (!isReview && val === plannedStart - 1) {
      // 「進んでいない」状態（actualEnd === plannedStart - 1）
      hasNotProgressed = true;
      notProgressedLabels.push(label);
    } else if (!isReview && val > plannedEnd) {
      // 新規タスクで予定より進んだ場合のみスケジュール再調整バナーを表示
      hasAhead = true;
      aheadMessages.push(`${label}: ${val - plannedEnd}${unit}多く進みました！`);
    } else if (val < plannedEnd && (val >= plannedStart || (isReview && val === plannedStart - 1))) {
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
      // 「進んでいない」タスクごとに繰越メッセージを1行ずつ表示
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
 * 進捗を保存してスケジュールを再描画
 * @param {string} [baseId] - buildProgressInputSection に渡したものと同じベースID
 */
function handleProgressSave(dateStr, baseId) {
  baseId = baseId || dateStr;
  const container = document.getElementById(`progress-section-${baseId}`);
  if (!container) return;

  const inputs = container.querySelectorAll('.progress-num-input');
  let saved = 0;

  // 保存するレコードを収集（後で復習スケジュール表示に使う）
  const savedRecords = [];

  inputs.forEach(input => {
    const val = parseInt(input.value, 10);
    if (isNaN(val)) return;

    const type = input.dataset.type;
    const plannedStart = parseInt(input.dataset.plannedStart, 10);
    const plannedEnd   = parseInt(input.dataset.plannedEnd,   10);
    const bookName     = input.dataset.bookName || '';

    if (type === 'word-review' || type === 'book-review') {
      // ── 復習タスクの進捗記録（reviewKey で識別）──
      const reviewKey = input.dataset.reviewKey;
      dailyProgress = dailyProgress.filter(
        p => !(p.date === dateStr && p.reviewKey === reviewKey && p.type === type)
      );
      const record = {
        id: 'dp_' + crypto.randomUUID(),
        date: dateStr,
        reviewKey,
        type,
        plannedStart,
        plannedEnd,
        actualEnd: val,
        bookName,
        notProgressed: val === plannedStart - 1  // ← 追加: 進捗なし（actualEnd === plannedStart - 1）のフラグ
      };
      dailyProgress.push(record);
      // ── reviewDoneSet を進捗状態と連動して更新 ──
      // val が plannedEnd に達していれば完了済みとしてセットに追加し、
      // 未達の場合（途中・進捗なし含む）は削除してカレンダーに残すようにする。
      if (val >= plannedEnd) {
        reviewDoneSet.add(reviewKey.replace(/_moved_\d{4}-\d{2}-\d{2}$/, ''));
      } else {
        reviewDoneSet.delete(reviewKey.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '')); // originalKey を削除
      }
      savedRecords.push(record);
      saved++;
    } else {
      // ── 新規タスク（word / book）の進捗記録（entryId で識別）──
      const entryId = input.dataset.entryId;
      // word: entryId は composite key（entryId_chunkDate_rangeStart）、originEntryId は元の entry.id
      const originEntryId = input.dataset.originEntryId || undefined;
      // book タイプは planId（参考書プランID）も別途保持する
      // entryId は「planId_originalDate_rangeStart」の複合キーなので refEntries への紐付けに planId を使う
      const planId = input.dataset.planId || entryId;
      // ── Bug 1 修正：保存前に旧キーを reviewDoneSet から除去 ──
      // 再保存前に旧キーを reviewDoneSet から除去する。
      // キー形式: `${prefix}_prog_${resolved}_${p.date}_${p.plannedStart}_${n}` (actualEnd はキーに含めない)
      // handleProgressClear の ② と同じロジックを適用する。
      dailyProgress
        .filter(p => p.date === dateStr && p.entryId === entryId && p.type === type && !p.notProgressed)
        .forEach(p => {
          const prefix   = type === 'word' ? 'w' : 'r';
          const resolved = type === 'word'
            ? (p.originEntryId || p.entryId)
            : (p.planId || p.entryId);
          const entity = type === 'word'
            ? entries.find(e => e.id === resolved)
            : refEntries.find(r => r.id === resolved);
          if (!entity) return;
          const intervals = type === 'book'
            ? DEFAULT_INTERVALS
            : ((entity && entity.intervals) ? entity.intervals : DEFAULT_INTERVALS);
          intervals.forEach(n => {
            const key = `${prefix}_prog_${resolved}_${p.date}_${p.plannedStart}_${n}`;
            reviewDoneSet.delete(key);
            reviewDoneSet.delete(key.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '')); // movedKey 派生も念のため削除
          });
        });
      dailyProgress = dailyProgress.filter(
        p => !(p.date === dateStr && p.entryId === entryId && p.type === type)
      );
      const record = {
        id: 'dp_' + crypto.randomUUID(),
        date: dateStr,
        entryId,
        originEntryId: type === 'word' ? originEntryId : undefined, // ★ word: 元の entry.id を別途保存
        planId: type === 'book' ? planId : undefined, // book のみ planId を保持
        type,
        plannedStart,
        plannedEnd,
        actualEnd: val,
        bookName,
        notProgressed: val === plannedStart - 1  // ← 追加: 進捗なし（actualEnd === plannedStart - 1）のフラグ
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
  // スケジュール全体を再描画（進捗に基づき再計算される）
  saveReviewDone(); // ← 追加：reviewDoneSet の変更を永続化
  renderIntegratedSchedule();
  refreshAllSchedules();
  renderRefTodayCard();

  // スケジュールタブ内の進捗セクションに単語復習プレビューを注入
  const wordRecordsForPreview = savedRecords.filter(r => r.type === 'word');
  if (wordRecordsForPreview.length > 0) {
    // renderIntegratedSchedule() 後に再生成された progress-section を探す
    // スケジュールタブでは baseId === dateStr
    const progressSectionEl = document.getElementById(`progress-section-${dateStr}`);
    if (progressSectionEl) {
      // 既存のプレビューがあれば除去（重複防止）
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

/**
 * 単語の進捗記録から「復習スケジュールプレビュー」HTMLを生成するヘルパー。
 * スケジュールタブ内インジェクションから呼ばれる。
 * @param {string} dateStr     - 進捗を記録した日付 (YYYY-MM-DD)
 * @param {Array}  wordRecords - type === 'word' の savedRecords 配列
 * @returns {string} HTML文字列（対象なしの場合は空文字）
 */
function buildWordReviewPreviewHtml(dateStr, wordRecords) {
  if (!wordRecords || wordRecords.length === 0) return '';

  let wordsHtml = '';
  let hasAnyReview = false; // 復習スロットが1件以上生成されたか（タイトル分岐用）

  wordRecords.forEach(rec => {
    // ── 「進んでいない」レコードはスロット表示をスキップし繰越メッセージを表示 ──
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
      return; // 復習スロット生成をスキップ
    }

    // ── 通常の進捗レコード ──
    const entry = entries.find(e => e.id === (rec.originEntryId || rec.entryId));
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

    const slotsHtml = (entry.intervals || DEFAULT_INTERVALS).map(n => {
      const d = addDays(parseISO(dateStr), n);
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

  // タイトルを内容に合わせて分岐（全件繰越 / 一部繰越 / 全件復習追加）
  const sectionTitle = hasAnyReview
    ? '📖 単語の進捗を記録 — 復習スケジュールが追加されました'
    : '📖 単語の進捗を記録 — 繰り越し処理が完了しました';

  return `<div class="progressed-review-section" style="margin-top:16px;">
    <div class="progressed-review-title">${sectionTitle}</div>
    ${wordsHtml}
  </div>`;
}

/**
 * 今日の進捗記録をクリアしてスケジュールを元に戻す
 */
function handleProgressClear(dateStr) {
  if (!confirm(`${dateStr} の進捗記録をリセットしますか？\nスケジュールが元の計画に戻ります。`)) return;
  // dailyProgress を削除する前に、対象日の復習キーを reviewDoneSet から除去
  const reviewKeysToRemove = dailyProgress
    .filter(p => p.date === dateStr && (p.type === 'word-review' || p.type === 'book-review') && p.reviewKey)
    .map(p => p.reviewKey);
  reviewKeysToRemove.forEach(k => {
    reviewDoneSet.delete(k);
    reviewDoneSet.delete(k.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '')); // 追加: originalKey も削除
  });

  // ② word/book 型の進捗記録から buildProgressReviews() で生成されるレビューキーも除去する。
  // カレンダーのチェックボックスで reviewDoneSet に追加されたキーが、クリア後の再記録時に
  // 「完了済み」と誤認されるのを防ぐための修正。
  // キー形式: `${prefix}_prog_${resolved}_${p.date}_${p.plannedStart}_${n}` (actualEnd はキーに含めない)
  dailyProgress
    .filter(p => p.date === dateStr && (p.type === 'word' || p.type === 'book') && !p.notProgressed)
    .forEach(p => {
      const prefix   = p.type === 'word' ? 'w' : 'r';
      const resolved = p.type === 'word'
        ? (p.originEntryId || p.entryId)
        : (p.planId || p.entryId);
      const entity = p.type === 'word'
        ? entries.find(e => e.id === resolved)
        : refEntries.find(r => r.id === resolved);
      const intervals = p.type === 'book'
        ? DEFAULT_INTERVALS
        : ((entity && entity.intervals) ? entity.intervals : DEFAULT_INTERVALS);
      intervals.forEach(n => {
        const key = `${prefix}_prog_${resolved}_${p.date}_${p.plannedStart}_${n}`;
        reviewDoneSet.delete(key);
        reviewDoneSet.delete(key.replace(/_moved_\d{4}-\d{2}-\d{2}$/, '')); // movedKey 派生も念のため削除
      });
    });

  saveReviewDone();

  dailyProgress = dailyProgress.filter(p => p.date !== dateStr);
  saveDailyProgress();
  renderIntegratedSchedule();
  refreshAllSchedules();
  renderRefTodayCard();
}

function renderTodayNew(){
  const box = document.getElementById('todayNewBox');
  if (!box) return;
  const todayIso = todayISO();
  const { vocabChunks: allChunks } = buildScheduleData();
  const todayChunks = allChunks.filter(c => c.date === todayIso);
  if(todayChunks.length === 0){
    box.innerHTML = `<div class="empty-mini">今日の新規範囲はありません。</div>`;
  }else{
    box.innerHTML = todayChunks.map(c => `<span class="today-new-tag">${c.rangeStart}〜${c.rangeEnd}</span>`).join('');
  }
}

/**
 * 参考書タブの「今日やること」カードを描画する。
 * - 今日の新規参考書チャンク（繰り越し含む）を緑タグで表示
 * - 今日の参考書復習をチェックボックス付きで表示
 */
function renderRefTodayCard() {
  const newBox    = document.getElementById('refTodayNewBox');
  const reviewList = document.getElementById('refTodayReviewList');
  if (!newBox || !reviewList) return;

  const todayStr = todayISO();
  const { refChunks, refReviews } = buildScheduleData();

  // ── 今日の新規範囲 ──────────────────────────────────────────
  const todayChunks = refChunks.filter(c => c.date === todayStr);
  if (todayChunks.length === 0) {
    newBox.innerHTML = '<div class="empty-mini">今日の参考書範囲はありません。</div>';
  } else {
    newBox.innerHTML = todayChunks.map(c => {
      // STEP 8: 未完了繰越バッジを統一形式で表示（carriedForward / isCarriedNew 両対応）
      const cfBadge = c.carriedForward
        ? buildCarryBadgeHtml(c.originalDate)
        : (c.isCarriedNew ? buildCarryBadgeHtml(c.originalDate || null) : '');
      return `<span class="today-ref-tag">${escapeHtml(c.bookName)}<br><span style="font-weight:400;font-size:.82em;">p.${c.rangeStart}〜${c.rangeEnd}</span>${cfBadge ? '<br>' + cfBadge : ''}</span>`;
    }).join('');
  }

  // ── 今日の復習 ──────────────────────────────────────────────
  const todayReviews = refReviews.filter(r => r.date === todayStr);
  if (todayReviews.length === 0) {
    reviewList.innerHTML = '<div class="empty-mini">今日の参考書復習はありません。</div>';
  } else {
    // 未完了を先頭、完了済みを後ろに並べる
    const sorted = [...todayReviews].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    const itemsHtml = sorted.map(r => {
      const ts = getIntervalTierStyle(r.interval);
      // STEP 8: 復習バッジを統一形式で表示（🔁 復習 Lv.X [N日後] + 🔄 [遅れN日]）
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
  refreshAllSchedules();
  renderTodayNew();
}

// ── 単語スケジュールの編集モード ──────────────────────────────

// 現在のフォーム入力内容をスナップショットとして取得（キャンセル時の復元用）
function getPlanFormState(){
  return {
    planMode: document.querySelector('input[name="planMode"]:checked')?.value || 'byRange',
    startNum: document.getElementById('startNum').value,
    endNum: document.getElementById('endNum').value,
    startDate: document.getElementById('startDate').value,
    endDate: document.getElementById('endDate').value,
    amountPerDay: document.getElementById('amountPerDay').value,
    weekdays: getCheckedValues('weekdayRow'),
    reviewWeekdays: getCheckedValues('reviewWeekdayRow'),
    intervals: getCheckedValues('intervalRow'),
  };
}

// スナップショット（または既存エントリの値）をフォームへ反映する
function setPlanFormState(state){
  if (!state) return;
  const modeRadio = document.querySelector(`input[name="planMode"][value="${state.planMode}"]`);
  if (modeRadio) {
    modeRadio.checked = true;
    modeRadio.dispatchEvent(new Event('change')); // 表示切替（既存の change ハンドラを再利用）
  }
  document.getElementById('startNum').value = state.startNum ?? '';
  document.getElementById('endNum').value = state.endNum ?? '';
  document.getElementById('startDate').value = state.startDate ?? '';
  document.getElementById('endDate').value = state.endDate ?? '';
  document.getElementById('amountPerDay').value = state.amountPerDay ?? '';
  setCheckedValues('weekdayRow', state.weekdays || []);
  setCheckedValues('reviewWeekdayRow', state.reviewWeekdays || []);
  setCheckedValues('intervalRow', state.intervals || []);
}

// 「編集」ボタン押下時：フォームに既存エントリの内容を読み込み、編集モードに入る
function startEditEntry(id){
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  // 今フォームに入っている内容を退避（キャンセルされた場合に戻すため）
  entryFormSnapshot = getPlanFormState();

  setPlanFormState({
    planMode: entry.planMode,
    startNum: entry.startNum,
    endNum: entry.endNum,
    startDate: entry.startDate,
    endDate: entry.endDate,
    amountPerDay: entry.amountPerDay,
    weekdays: entry.weekdays,
    reviewWeekdays: entry.reviewWeekdays,
    intervals: entry.intervals,
  });

  editingEntryId = id;
  const errorEl = document.getElementById('errorMsg');
  if (errorEl) errorEl.textContent = '';

  const addBtn = document.getElementById('addBtn');
  if (addBtn) addBtn.textContent = '✅ 変更を保存';
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = '';

  // 設定パネルを開いてフォームまでスクロール（閉じていても編集内容が見えるように）
  const setupDetails = document.getElementById('setup');
  if (setupDetails) setupDetails.open = true;
  setupDetails?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  renderEntryList(); // 編集中の行をハイライトするため再描画
}

// ボタン表示・状態だけを新規追加モードへ戻す（フォーム内容には触れない）
function exitEntryEditMode(){
  editingEntryId = null;
  entryFormSnapshot = null;
  const addBtn = document.getElementById('addBtn');
  if (addBtn) addBtn.textContent = 'この範囲をスケジュールに追加';
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
}

// 「編集をキャンセル」ボタン押下時：フォームを編集前の状態に戻す
function cancelEditEntry(){
  const snapshot = entryFormSnapshot;
  exitEntryEditMode();
  setPlanFormState(snapshot);
  renderEntryList();
}

async function handleAdd(){
  const startNum = Number(document.getElementById('startNum').value);
  const endNum = Number(document.getElementById('endNum').value);
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value; // 追加
  const weekdays = getCheckedValues('weekdayRow');
  const reviewWeekdays = getCheckedValues('reviewWeekdayRow'); // ★復習曜日を取得
  const intervals = getCheckedValues('intervalRow');
  const errorEl = document.getElementById('errorMsg');
  const planMode = document.querySelector('input[name="planMode"]:checked').value;
  const amountPerDay = Number(document.getElementById('amountPerDay').value);
  const showError = (msg) => { if (errorEl) errorEl.textContent = msg; else alert(msg); };
  if (errorEl) errorEl.textContent = '';

  if(!startNum || !endNum || endNum < startNum){
    showError('開始番号・終了番号を正しく入力してください（終了番号は開始番号以上）。'); return;
  }
  if(!startDate){ showError('開始日を選択してください。'); return; }
  
  // 終了日のバリデーションを追加
  if(planMode === 'byRange') {
    if(!endDate){ showError('終了日を選択してください。'); return; }
    if(new Date(endDate) < new Date(startDate)){ showError('終了日は開始日以降の日付にしてください。'); return; }
  }

  if(weekdays.length === 0){ showError('学習する曜日を1つ以上選んでください。'); return; }
  if(intervals.length === 0){ showError('復習のタイミングを1つ以上選んでください。'); return; }
  if(planMode === 'byAmount' && (!amountPerDay || amountPerDay <= 0)){
    showError('1日あたりの単語数を正しく入力してください。'); return;
  }

  if (editingEntryId) {
    // 編集モード：IDを維持したまま内容だけ差し替える
    // （IDを変えると復習履歴・進捗記録との紐付けが切れてしまうため）
    entries = entries.map(e => e.id === editingEntryId
      ? { ...e, startNum, endNum, startDate, endDate, weekdays, reviewWeekdays, intervals, planMode, amountPerDay }
      : e);
    exitEntryEditMode();
  } else {
    // entryオブジェクトに endDate と reviewWeekdays を追加
    entries.push({ id: 'e' + Date.now(), startNum, endNum, startDate, endDate, weekdays, reviewWeekdays, intervals, planMode, amountPerDay });
  }
  await saveEntries();
  renderAll();
}

async function handleReset(){
  if(!confirm('登録した範囲をすべて削除します。よろしいですか？')) return;
  entries = [];
  exitEntryEditMode(); // 全削除時は編集状態も解除しておく
  await saveEntries();
  renderAll();
}

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
    id: 'w_' + crypto.randomUUID(), word, meaning, stepIndex: 0,
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
  const dueList        = document.getElementById('dueList');
  const activeSummary  = document.getElementById('activeSummary');
  const activeTable    = document.getElementById('activeTable');
  const graduatedSummary = document.getElementById('graduatedSummary');
  const gradTable      = document.getElementById('graduatedTable');
  if(!dueList || !activeSummary || !activeTable || !graduatedSummary || !gradTable) return;

  const todayIso = todayISO();
  const active = leechWords.filter(w => w.status === 'active');
  const graduated = leechWords.filter(w => w.status === 'graduated');
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
        <button class="speak-btn" data-word="${escapeHtml(w.word)}" style="background:none; border:none; cursor:pointer; font-size:1rem; margin-left:6px;">🔊</button>
        ${w.missCount >= LEECH_WARN_THRESHOLD ? '<span class="badge-warn">要注意</span>' : ''}
       </td>
       <td>${w.nextReviewDate}</td>
       <td>${w.missCount}</td>
       <td><button class="mini-del" data-id="${w.id}">削除</button></td>
      </tr>`).join('')}
    `;
    activeTable.querySelectorAll('.speak-btn').forEach(btn => {
      btn.addEventListener('click', () => speakWord(btn.dataset.word));
    });
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
function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

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
    id: 's_' + crypto.randomUUID(),
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
  }

  currentTestIdx = 0;
  testSessionResults = [];
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

document.getElementById('testCorrectBtn')?.addEventListener('click', async () => {
  const wordData = testQueue[currentTestIdx];
  testSessionResults.push({ word: wordData.word, correct: true });
  await handleLeechCorrect(wordData.id);
  currentTestIdx++;
  showTestWord();
});

document.getElementById('testWrongBtn')?.addEventListener('click', async () => {
  const wordData = testQueue[currentTestIdx];
  testSessionResults.push({ word: wordData.word, correct: false });
  await handleLeechWrong(wordData.id);
  currentTestIdx++;
  showTestWord();
});

function finishTest() {
  document.getElementById('testArea').style.display = 'none';
  document.getElementById('resultArea').style.display = 'block';
  const correctCount = testSessionResults.filter(r => r.correct).length;
  const rate = testQueue.length > 0 ? Math.round((correctCount / testQueue.length) * 100) : 0;
  document.getElementById('resultScore').textContent = `正答率: ${correctCount} / ${testQueue.length} (${rate}%)`;
  document.getElementById('resultList').innerHTML = testSessionResults.map(r => `
    <div class="result-item">
      <span style="font-family:'IBM Plex Mono', monospace; font-weight:700;">${r.word}</span>
      <span style="color:${r.correct ? 'var(--success)' : 'var(--margin-red)'}; font-weight:700;">
        ${r.correct ? '〇 できた' : '✖ もう一度'}
      </span>
    </div>
  `).join('');
}

/* ---------- TTS (読み上げ機能) ---------- */
function speakWord(text) {
  window.speechSynthesis.cancel(); // 連続読み上げを防ぐ
  const uttr = new SpeechSynthesisUtterance(text);
  uttr.lang = 'en-US'; // 英語の読み上げ設定
  uttr.rate = 0.9;     // 少しだけゆっくりにする（聞き取りやすく）
  window.speechSynthesis.speak(uttr);
}

// モーダルを閉じる処理
document.getElementById('closeTestBtn')?.addEventListener('click', () => {
  document.getElementById('testModal').classList.remove('active');
  renderLeech();
});

function showTab(tabName) {
  // タブコンテンツの表示・非表示を切り替え
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  const tabEl = document.getElementById('tab-' + tabName);
  if (tabEl) tabEl.style.display = 'block';

  // 「スケジュール」タブを開いたときは、最新の統合スケジュールを再描画する
  if (tabName === 'schedule') {
    renderIntegratedSchedule();
  }

  // デスクトップ用タブボタンの切り替え
  const tabBtns = { schedule:'tabSchedule', study:'tab-btn-study', coach:'tab-btn-coach',
                    analysis:'tab-btn-analysis', reference:'tab-btn-reference' };
  Object.entries(tabBtns).forEach(([name, id]) => {
    const el = document.getElementById(id);
    if (el) el.className = name === tabName ? 'btn-primary' : 'btn-ghost';
  });

  // モバイル用ボトムナビの active 切り替え
  const bnavIds = { schedule:'bnav-schedule', study:'bnav-study', reference:'bnav-reference',
                    coach:'bnav-coach', analysis:'bnav-analysis' };
  Object.entries(bnavIds).forEach(([name, id]) => {
    document.getElementById(id)?.classList.toggle('active', name === tabName);
  });

  // モバイルでタブ切り替え時に最上部へスクロール
  if (window.innerWidth <= 640) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// [ai-features.html] AI Coaching API Chat Logic（chatHistory / abortController / DOM参照 /
//                    appendMessage / handleChatSend / generateFinalPlan /
//                    continueChat / resetChat）→ ai-features.html に移動
// [ai-features.html] loadSavedApiKey / saveApiKey / setupApiKeyPersistence → ai-features.html に移動

(async function init(){
  buildWeekdayChips();
  buildWeekdayChips('reviewWeekdayRow', [0, 3, 6]);    // デフォルト：日・水・土
  buildIntervalChips();
  const startDateEl = document.getElementById('startDate');
  if (startDateEl) startDateEl.value = todayISO();
  document.getElementById('addBtn')?.addEventListener('click', handleAdd);
  document.getElementById('resetBtn')?.addEventListener('click', handleReset);
  document.getElementById('cancelEditBtn')?.addEventListener('click', cancelEditEntry);
  document.getElementById('leechAddBtn')?.addEventListener('click', handleLeechAdd);
  document.getElementById('printBtn')?.addEventListener('click', () => window.print());

  // 【追加】ラジオボタンで入力欄を切り替えるイベント
  document.querySelectorAll('input[name="planMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'byAmount') {
        document.getElementById('amountFieldWrap').style.display = ''; 
        document.getElementById('endDateWrap').style.display = 'none';
      } else {
        document.getElementById('amountFieldWrap').style.display = 'none';
        document.getElementById('endDateWrap').style.display = '';
      }
    });
  });

  // 期間ラジオボタンが切り替わったら再描画
  document.querySelectorAll('input[name="schedulePeriod"]').forEach(radio => {
    radio.addEventListener('change', renderIntegratedSchedule);
  });

  // setupApiKeyPersistence / loadSavedApiKey はjs-ai-features.jsのinitAiFeatures()が担当
  loadReviewDone();
  loadDailyProgress(); // 日別進捗データを読み込む
  await loadEntries();
  renderAll();
  loadRefEntries(); // 参考書データを先に読み込む（DOMContentLoadedから移動）
  renderIntegratedSchedule(); // 「スケジュール」タブは初期表示タブなので、読み込み直後に描画する
  renderMonthGoalCard();      // 月目標カードを初期表示
  document.getElementById('monthGoalEditBtn')?.addEventListener('click', openMonthGoalEditor);
  document.getElementById('monthGoalSaveBtn')?.addEventListener('click', handleMonthGoalSave);
  document.getElementById('monthGoalCancelBtn')?.addEventListener('click', closeMonthGoalEditor);
  await loadLeech();
  renderLeech();

  // ---- 成績・弱点分析タブの初期化 ----
  const scoreDateEl = document.getElementById('scoreDate');
  if(scoreDateEl) scoreDateEl.value = todayISO();
  // scoreAddBtn はjs-app.js定義のhandleScoreAddを使うためここで登録
  if(document.getElementById('scoreAddBtn')) document.getElementById('scoreAddBtn').addEventListener('click', handleScoreAdd);
  // handleScoreImageFile / runWeaknessAnalysis はjs-ai-features.jsのinitAiFeatures()が担当
  await loadScores();
  renderScoreList();
  try {
    const savedAnalysis = localStorage.getItem(ANALYSIS_KEY);
    // renderAnalysisResultはjs-ai-features.jsで定義されるためtypeof守衛
    if(savedAnalysis && typeof renderAnalysisResult === 'function') renderAnalysisResult(JSON.parse(savedAnalysis).result);
  } catch(e) {}
})();

/* =========================================================
   参考書スケジュール管理ロジック
========================================================= */

// ① 初期化（今日の日付をセットし、保存されたデータを読み込む）
window.addEventListener('DOMContentLoaded', () => {
  const refStartDateInput = document.getElementById('refStartDate');
  if(refStartDateInput) {
    const today = new Date();
    refStartDateInput.value = today.toISOString().split('T')[0];
  }

  // 学習する曜日のチップを生成（単語スケジュールと同じ仕組みを再利用）
  buildWeekdayChips('refWeekdayRow', DEFAULT_WEEKDAYS);
  buildWeekdayChips('refReviewWeekdayRow', [0, 3, 6]); // デフォルト：日・水・土
  // 復習インターバルは進捗入力時に DEFAULT_INTERVALS で自動生成するため、チップ選択UIは不要

  // 割り振り方法（曜日から設定 / 1日あたりの量から設定）の切り替え
  document.querySelectorAll('input[name="refPlanMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isByAmount = e.target.value === 'byAmount';
      document.getElementById('refAmountFieldWrap').style.display = isByAmount ? 'block' : 'none';
      document.getElementById('refEndDateWrap').style.display = isByAmount ? 'none' : 'block';
    });
  });

  // loadRefEntries() / renderIntegratedSchedule() / renderRefTodayCard() は
  // init() → loadRefEntries() → renderRefSchedule() → renderRefTodayCard() の
  // ルートで既にカバーされているため、ここでの呼び出しは不要（二重実行・競合防止）

  // ③ 「スケジュールを登録」ボタンが押された時の処理
  const saveRefPlanBtn = document.getElementById('saveRefPlanBtn');
  if (saveRefPlanBtn) {
    saveRefPlanBtn.addEventListener('click', () => {
      const errorEl = document.getElementById('refErrorMsg');
      if (errorEl) errorEl.textContent = '';

      const bookName = document.getElementById('refBookName').value.trim();
      const startNum = parseInt(document.getElementById('refStartNum').value, 10);
      const endNum = parseInt(document.getElementById('refEndNum').value, 10);
      const startDate = document.getElementById('refStartDate').value;
      const planMode = document.querySelector('input[name="refPlanMode"]:checked').value;
      const weekdays = getCheckedValues('refWeekdayRow');
      const reviewWeekdays = getCheckedValues('refReviewWeekdayRow'); // ★復習曜日を取得

      const showError = (msg) => { if (errorEl) errorEl.textContent = msg; else alert(msg); };

      if (!bookName || isNaN(startNum) || isNaN(endNum) || !startDate) {
        showError('すべての項目を正しく入力してください。');
        return;
      }
      if (startNum > endNum) {
        showError('開始ページは終了ページ以下の数値を入力してください。');
        return;
      }
      if (weekdays.length === 0) {
        showError('学習する曜日を1つ以上選んでください。');
        return;
      }

      const newPlan = {
        // id は下部で「新規なら新規発行／編集中なら既存IDを維持」して設定する
        bookName: bookName,
        startNum: startNum,
        endNum: endNum,
        startDate: startDate,
        weekdays: weekdays,
        reviewWeekdays: reviewWeekdays, // ★復習曜日を保存
        planMode: planMode
      };

      if (planMode === 'byAmount') {
        const amount = parseInt(document.getElementById('refAmountPerDay').value, 10);
        if (!amount || amount <= 0) {
          showError('1日あたり進める量を正しく入力してください。');
          return;
        }
        newPlan.amountPerDay = amount;
      } else {
        const endDate = document.getElementById('refEndDate').value;
        if (!endDate) {
          showError('終了日を選択してください。');
          return;
        }
        if (parseISO(endDate) < parseISO(startDate)) {
          showError('終了日は開始日以降の日付にしてください。');
          return;
        }
        newPlan.endDate = endDate;
      }

      // 事前にスケジュールを計算し、該当日がなければ登録前に知らせる
      if (computeRefSchedule(newPlan).length === 0) {
        showError('指定した期間・曜日では学習日がありません。設定を見直してください。');
        return;
      }

      if (editingRefEntryId) {
        // 編集モード：IDを維持したまま内容だけ差し替える
        // （IDを変えると復習履歴・進捗記録との紐付けが切れてしまうため）
        newPlan.id = editingRefEntryId;
        refEntries = refEntries.map(p => p.id === editingRefEntryId ? newPlan : p);
        exitRefEditMode();
      } else {
        newPlan.id = 'ref_' + Date.now();
        refEntries.push(newPlan);
      }
      saveRefEntries();
      renderRefSchedule(); // 画面を更新

      // 入力欄をクリア（教材名・ページ番号のみ）
      document.getElementById('refBookName').value = '';
      document.getElementById('refStartNum').value = '';
      document.getElementById('refEndNum').value = '';

      // 登録完了後：設定アコーディオンを閉じて「今日の確認」に注目させる
      const settingDetails = document.getElementById('refSettingDetails');
      if (settingDetails) settingDetails.open = false;
    });
  }

  document.getElementById('cancelRefEditBtn')?.addEventListener('click', cancelEditRefEntry);
});

// ①-2 参考書スケジュールの計算（単語スケジュールのcomputeChunksForEntryと同じ考え方）
// planMode === 'byAmount' : 1日あたりの量を指定 → 終了日は自動計算
// planMode === 'byRange'  : 開始日〜終了日と学習曜日を指定 → 1日あたりの量は自動計算
// ② データの保存と読み込み
function saveRefEntries() {
  saveToStorage(REF_STORAGE_KEY, refEntries);
}
function loadRefEntries() {
  refEntries = loadFromStorage(REF_STORAGE_KEY);
  if (refEntries.length > 0) {
    renderRefSchedule(); // 読み込み後すぐに描画
    // 既にスケジュールが登録されている場合：設定アコーディオンを初期状態で閉じる
    // （「今日の確認」エリアを最初に見せることでUXを改善）
    const settingDetails = document.getElementById('refSettingDetails');
    if (settingDetails) settingDetails.open = false;
  }
}

// ④ 参考書スケジュール：登録済みプランの一覧表示（単語タブのentryListと同じ考え方）
function renderRefEntryList(){
  const list = document.getElementById('refEntryList');
  if(!list) return;
  list.innerHTML = '';
  if(refEntries.length === 0) return;

  refEntries.forEach(plan => {
    const wdLabel = (plan.weekdays || []).slice().sort((a,b)=>a-b).map(i => WEEKDAYS[i]).join('・');
    const chunks = computeRefSchedule(plan);

    let calcInfo = '';
    if(chunks.length > 0){
      if(plan.planMode === 'byAmount'){
        const last = parseISO(chunks[chunks.length - 1].date);
        calcInfo = `1日あたり ${plan.amountPerDay} ／ 終了予定日 ${last.getMonth()+1}/${last.getDate()}（自動計算）`;
      } else {
        const amounts = chunks.map(c => c.rangeEnd - c.rangeStart + 1);
        const minA = Math.min(...amounts), maxA = Math.max(...amounts);
        calcInfo = (minA === maxA) ? `1日あたり ${minA}（自動計算）` : `1日あたり ${minA}〜${maxA}（自動計算）`;
      }
    } else {
      calcInfo = '該当する学習日がありません';
    }

    const item = document.createElement('div');
    item.className = 'entry-item' + (plan.id === editingRefEntryId ? ' is-editing' : '');
    item.innerHTML = `
      <div>
        <span class="rng">${escapeHtml(plan.bookName)}　${plan.startNum}〜${plan.endNum}</span>
        <div class="meta">開始日 ${plan.startDate} ／ 学習日: ${wdLabel || '―'} ／ ${calcInfo} ／ 復習: 進捗入力時に自動設定</div>
      </div>
      <div class="entry-actions">
        <button class="edit-btn ref-edit-btn" data-id="${plan.id}">編集</button>
        <button class="del-btn ref-del-btn" data-id="${plan.id}">削除</button>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.ref-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => startEditRefEntry(btn.dataset.id));
  });
  list.querySelectorAll('.ref-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('この参考書のスケジュールを削除しますか？')) return;
      // 編集中の項目が削除された場合は編集モードを解除しておく（不整合防止）
      if (editingRefEntryId === btn.dataset.id) exitRefEditMode();
      refEntries = refEntries.filter(p => p.id !== btn.dataset.id);
      saveRefEntries();
      renderRefSchedule();
    });
  });
}

// ── 参考書スケジュールの編集モード ────────────────────────────

function getRefFormState(){
  return {
    planMode: document.querySelector('input[name="refPlanMode"]:checked')?.value || 'byRange',
    bookName: document.getElementById('refBookName').value,
    startNum: document.getElementById('refStartNum').value,
    endNum: document.getElementById('refEndNum').value,
    startDate: document.getElementById('refStartDate').value,
    endDate: document.getElementById('refEndDate').value,
    amountPerDay: document.getElementById('refAmountPerDay').value,
    weekdays: getCheckedValues('refWeekdayRow'),
    reviewWeekdays: getCheckedValues('refReviewWeekdayRow'),
  };
}

function setRefFormState(state){
  if (!state) return;
  const modeRadio = document.querySelector(`input[name="refPlanMode"][value="${state.planMode}"]`);
  if (modeRadio) {
    modeRadio.checked = true;
    modeRadio.dispatchEvent(new Event('change'));
  }
  document.getElementById('refBookName').value = state.bookName ?? '';
  document.getElementById('refStartNum').value = state.startNum ?? '';
  document.getElementById('refEndNum').value = state.endNum ?? '';
  document.getElementById('refStartDate').value = state.startDate ?? '';
  document.getElementById('refEndDate').value = state.endDate ?? '';
  document.getElementById('refAmountPerDay').value = state.amountPerDay ?? '';
  setCheckedValues('refWeekdayRow', state.weekdays || []);
  setCheckedValues('refReviewWeekdayRow', state.reviewWeekdays || []);
}

function startEditRefEntry(id){
  const plan = refEntries.find(p => p.id === id);
  if (!plan) return;

  refFormSnapshot = getRefFormState();

  setRefFormState({
    planMode: plan.planMode,
    bookName: plan.bookName,
    startNum: plan.startNum,
    endNum: plan.endNum,
    startDate: plan.startDate,
    endDate: plan.endDate,
    amountPerDay: plan.amountPerDay,
    weekdays: plan.weekdays,
    reviewWeekdays: plan.reviewWeekdays,
  });

  editingRefEntryId = id;
  const errorEl = document.getElementById('refErrorMsg');
  if (errorEl) errorEl.textContent = '';

  const saveBtn = document.getElementById('saveRefPlanBtn');
  if (saveBtn) saveBtn.textContent = '✅ 変更を保存';
  const cancelBtn = document.getElementById('cancelRefEditBtn');
  if (cancelBtn) cancelBtn.style.display = '';

  const settingDetails = document.getElementById('refSettingDetails');
  if (settingDetails) settingDetails.open = true;
  settingDetails?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  renderRefEntryList();
}

function exitRefEditMode(){
  editingRefEntryId = null;
  refFormSnapshot = null;
  const saveBtn = document.getElementById('saveRefPlanBtn');
  if (saveBtn) saveBtn.textContent = 'スケジュールを生成して登録';
  const cancelBtn = document.getElementById('cancelRefEditBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function cancelEditRefEntry(){
  const snapshot = refFormSnapshot;
  exitRefEditMode();
  setRefFormState(snapshot);
  renderRefEntryList();
}

// ⑤ 参考書タブ全体の再描画（登録リスト＋今日やること）
function renderRefSchedule() {
  renderRefEntryList();
  refreshAllSchedules();
  renderRefTodayCard();
}
