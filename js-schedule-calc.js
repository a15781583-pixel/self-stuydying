/* =========================================================
   js-schedule-calc.js  ─  ③-a スケジュールへの反映（計算）
   ---------------------------------------------------------
   【こんなときに、このファイルを開く】
    ・学習範囲の1日ごとの割り振り（何日目にどこまでやるか）を直したい
    ・復習日の計算、遅れた復習のずらし方、繰り越しの扱いを直したい
    ・進捗入力にあわせた残りスケジュールの再配分を直したい
    ・※ 表示の見た目を直したいときは js-schedule-view.js
   【読み込み順】 ⑤ js-common.js の後
   ※ 中身のコードは、分割前の js-app.js と同一です（場所を移しただけ）。
========================================================= */

/* ───────── 復習日の計算・遅れた復習のずらし・繰り越し ───────── */
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
// ルール：予定日を過ぎてもクリアしていない項目は「今日」に移動する。
// 移動先の日付をキーに埋め込んだ movedKey を返すことで、移動のたびにチェック状態がリセットされる。
// 予定日が来ていない、またはすでにクリア済みの項目はずらさない。
function computeEffectiveReviewDate(originalIso, key){
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
    p.reviewKey != null && (p.reviewKey === key || p.reviewKey.replace(MOVED_KEY_SUFFIX_RE, '') === key) &&
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

  // ★ 遅れた場合：今日の日付に移動
  const newDate = todayIso;

  // ★ 移動先の日付をキーに埋め込むことで、移動毎にチェック状態をリセット
  const movedKey = `${key}_moved_${newDate}`;

  return { date: newDate, movedKey, delayedDays: diffDays, done: false };
}

// 復習リスト生成の共通コア処理（単語・参考書、チャンク起点・進捗記録起点の全パターンで共用）。
// 「originalDate計算 → key生成 → computeEffectiveReviewDate → push」という
// buildReviewsFromChunks/buildProgressReviews/addReviewsFromCf 共通のパターンを1箇所に集約する。
// items        : 元データ配列（chunks・progressItems などコレクション取得方法だけが呼び出し側で異なる）
// keyOf        : (item, interval) → 復習キー
// dateOf       : item → 起点日（学習日）のISO文字列
// rangeOf      : item → { rangeStart, rangeEnd }
// getIntervals : item → インターバル日数配列
// extraFields  : item → pushするオブジェクトに追加するフィールド
// out          : 結果をpushする配列（省略時は新規配列を作成して返す。addReviewsFromCf のように
//                既存配列へ追記したい場合は呼び出し側の配列を渡す）
function buildReviewEntries(items, keyOf, dateOf, rangeOf, getIntervals, extraFields, out = []) {
  items.forEach(item => {
    (getIntervals(item) || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(dateOf(item)), n));
      const key = keyOf(item, n);
      const eff = computeEffectiveReviewDate(originalDate, key);
      const { rangeStart, rangeEnd } = rangeOf(item);
      out.push({ date: eff.date, originalDate, rangeStart, rangeEnd,
        interval: n, key: eff.movedKey ?? key, delayedDays: eff.delayedDays, done: eff.done,
        ...extraFields(item) });
    });
  });
  return out;
}

// オリジナル計画チャンクから復習リストを生成する共通ヘルパー（単語・参考書共用）。
// chunks  : フィルタ済みチャンク配列
// prefix  : キー接頭辞（'w' or 'r'）
// getOwnerId  : chunk → ownerID（entryId or planId）
// getIntervals: chunk → インターバル日数配列
// extraFields : chunk → pushするオブジェクトに追加するフィールド
function buildReviewsFromChunks(chunks, prefix, getOwnerId, getIntervals, extraFields) {
  return buildReviewEntries(
    chunks,
    (c, n) => buildReviewKey(prefix, getOwnerId(c), c.rangeStart, c.rangeEnd, n),
    c => c.date,
    c => ({ rangeStart: c.rangeStart, rangeEnd: c.rangeEnd }),
    getIntervals,
    extraFields
  );
}

// 進捗記録ベースの復習リストを生成する共通ヘルパー（単語・参考書共用）。
// progressItems : フィルタ済み dailyProgress 配列
// prefix        : キー接頭辞（'w' or 'r'）
// getResolved   : p → resolvedId（entryId/planId）
// getEntity     : resolvedId → entries/refEntries の該当エントリ
// getIntervals  : entity → インターバル日数配列
// extraFields   : (p, resolved, entity) → 追加フィールド
function buildProgressReviews(progressItems, prefix, getResolved, getEntity, getIntervals, extraFields) {
  // entity が見つからない進捗記録は対象外（元の実装通り、コアヘルパーに渡す前に除外する）
  const resolvedItems = progressItems
    .map(p => {
      const resolved = getResolved(p);
      const entity = getEntity(resolved);
      // 【修正】到達番号が開始番号に満たない（＝1件も進んでいない）記録は、復習する範囲が存在しないため除外
      if (!(p.actualEnd >= p.plannedStart)) return null;
      return entity ? { p, resolved, entity } : null;
    })
    .filter(Boolean);

  return buildReviewEntries(
    resolvedItems,
    (item, n) => `${prefix}_prog_${item.resolved}_${item.p.date}_${item.p.plannedStart}_${n}`,
    item => item.p.date,
    item => ({ rangeStart: item.p.plannedStart, rangeEnd: item.p.actualEnd }),
    item => getIntervals(item.entity),
    item => extraFields(item.p, item.resolved, item.entity)
  );
}

// 単語・参考書の全復習項目（本来の日付＋ずらし後の実効日付）をまとめて計算する共通関数。
// renderMergedSchedule / renderIntegratedSchedule の両方から呼ばれる。
// ★ 進捗記録がある場合は computeAdjustedChunksForEntry / computeAdjustedRefSchedule を使い
//   残りのスケジュールを自動再配分する。
function buildAllReviews(){
  // ─── 単語 ─────────────────────────────────────────────────────────────
  // ★ 参考書（refChunks）と設計を共通化：各チャンクに教材名(bookName)を付与する
  const vocabChunks = entries.flatMap(entry =>
    computeAdjustedChunksForEntry(entry).map(c => ({ ...c, bookName: entry.bookName }))
  );

  // 進捗記録済み・繰り越しチャンクを除外してからヘルパーへ渡す
  // composite key でも照合（繰り越し後に入力したケースに対応）
  const filteredVocabChunks = vocabChunks.filter(c => {
    if (c.isFromProgress) return false;
    const chunkKey = `${c.entryId}_${c.date}_${c.rangeStart}`;
    return !dailyProgress.some(p => {
      if (p.type !== 'word' || p.notProgressed) return false; // ★notProgressed追加（繰越判定と揃える）
      if (p.originEntryId != null) return p.entryId === chunkKey; // 新形式
      return p.date === c.date && p.entryId === c.entryId; // 旧形式（★レコードに無い p.rangeStart の比較を削除）
    });
  });

  const rawVocabReviews = [
    ...buildReviewsFromChunks(
      filteredVocabChunks, 'w',
      c => c.entryId,
      c => c.intervals,
      c => ({ entryId: c.entryId, bookName: c.bookName })
    ),
    ...buildProgressReviews(
      dailyProgress.filter(p => p.type === 'word' && !p.notProgressed),
      'w',
      p => p.originEntryId || p.entryId,
      id => entries.find(e => e.id === id),
      entity => entity.intervals || DEFAULT_INTERVALS,
      (p, resolved, entity) => ({ entryId: resolved, bookName: entity.bookName })
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
      if (p.type !== 'book' || p.notProgressed) return false; // ★notProgressed追加（繰越判定と揃える）
      if (p.planId && p.planId !== p.entryId) return p.entryId === chunkKey; // 新形式
      return p.date === c.date && (p.planId || p.entryId) === c.planId;      // 旧形式
    });
  });

  const rawRefReviews = [
    ...buildReviewsFromChunks(
      filteredRefChunks, 'r',
      c => c.planId,
      c => (c.intervals && c.intervals.length ? c.intervals : DEFAULT_INTERVALS),
      c => ({ bookName: c.bookName, planId: c.planId })
    ),
    ...buildProgressReviews(
      dailyProgress.filter(p => p.type === 'book' && !p.notProgressed),
      'r',
      p => p.planId || p.entryId,
      id => refEntries.find(r => r.id === id),
      entity => (entity.intervals && entity.intervals.length ? entity.intervals : DEFAULT_INTERVALS),
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
    .filter(c => !c.isFromProgress) // ★修正：実績チャンク（完了済み）は繰越対象にしない
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
  const reviewBaseKey = review.key.replace(MOVED_KEY_SUFFIX_RE, '');
  if (reviewBaseKey !== expectedKey) return false;
  
  const expectedOriginal = formatISO(addDays(parseISO(cfChunk.originalDate), review.interval));
  return review.originalDate === expectedOriginal;
}


function addReviewsFromCf(cfList, prefix, filteredReviews, getOwnerId, getIntervals, extraFields) {
  buildReviewEntries(
    cfList,
    (c, n) => buildReviewKey(prefix, getOwnerId(c), c.rangeStart, c.rangeEnd, n),
    c => c.date,
    c => ({ rangeStart: c.rangeStart, rangeEnd: c.rangeEnd }),
    getIntervals,
    extraFields,
    filteredReviews // 既存配列に追記する（元の実装と同様、戻り値は使わない）
  );
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
    c => c.intervals,
    c => ({ entryId: c.entryId, bookName: c.bookName })
  );

  // ★ 修正：cfRef の繰越チャンクから新しい日付基準で復習を再生成（単語の cfVocab と対称）
  addReviewsFromCf(cfRef, 'r', filteredRefReviews,
    c => c.planId,
    c => (c.intervals && c.intervals.length ? c.intervals : DEFAULT_INTERVALS),
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

/* ───────── 日別進捗の保存・進捗にあわせた再配分 ───────── */
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
    // ★修正：到達番号（actualEnd）が最大の記録を最優先で返す。
    //   日付優先だと、後日に繰越の穴埋め（小さい番号）だけを入力した際、
    //   そちらが「最新」扱いとなり、完了済みの範囲が再配分されてしまう。
    .sort((a, b) => b.actualEnd - a.actualEnd || b.date.localeCompare(a.date));
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
    // computeEarlyDays 用：呼び出し元から渡された entry をそのまま対象として扱う
    resolveMaterial: (entry) => entry,
  },
  book: {
    type: 'book',
    computeBaseSchedule: (material) => computeRefSchedule(material),
    filterProgress: (materialId) => dailyProgress.filter(p =>
      p.type === 'book' &&
      !p.notProgressed &&
      (p.planId === materialId || p.entryId === materialId)
    ),
    // チャンクに付与する種別固有のフィールド（planId + intervals）
    chunkIdFields: (material) => ({ planId: material.id, intervals: material.intervals }),
    // computeEarlyDays 用：渡された entry の id を使って refEntries から最新のプランを取得する
    resolveMaterial: (entry) => refEntries.find(p => p.id === entry.id),
  },
};

/**
 * 進捗記録の「取りこぼし」（番号の穴）を、繰越チャンクとして返す。
 *
 * 穴 ＝ 「教材の開始番号〜最新の到達番号」のうち、どの進捗記録にも含まれない番号。
 * 例1：月〜水の分を入力しないまま、今日(木)の分だけ完了した → 月〜水の範囲が穴になる
 * 例2：繰り越された範囲を途中まで、今日の範囲を完了で入力した → 途中の残りが穴になる
 * 以前は、最新の到達番号の“次”から数え直すだけだったため、穴の部分が画面から消えていた。
 *
 * 置き場所のルール：
 *  ・今日「途中まで」と入力した残り → 次の学習日へ繰り越す（当日中には置かない）
 *  ・それ以外（未着手・前日までの途中の残り）→ 今日に繰り越す（遅れた分は今日やる）
 */
function buildLeftoverChunks(material, progressRecords, originalChunks, idFields, upTo, todayStr, nextStudyDay) {
  // 取り込み済みの範囲（マージして昇順に）
  const covered = progressRecords
    .filter(p => p.actualEnd >= p.plannedStart)
    .map(p => [p.plannedStart, p.actualEnd])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  covered.forEach(([s, e]) => {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  });
  // 穴（未取り込み範囲）を求める
  const gaps = [];
  let cur = material.startNum;
  merged.forEach(([s, e]) => {
    // 【修正】cur が upTo を超えている場合に、逆転した範囲（開始>終了）の穴が作られないようにする
    if (s > cur && cur <= upTo) gaps.push([cur, Math.min(s - 1, upTo)]);
    cur = Math.max(cur, e + 1);
  });
  if (cur <= upTo) gaps.push([cur, upTo]);

  // 穴の番号ごとに「どこから来た未完了か」を判定し、同じ出どころが続く範囲を1チャンクにまとめる
  const recsDesc = progressRecords.slice().sort((a, b) => b.date.localeCompare(a.date));
  const originOf = (n) => {
    // 途中まで入力された記録の“残り”に該当する番号
    const tail = recsDesc.find(p => p.actualEnd < p.plannedEnd && n > p.actualEnd && n <= p.plannedEnd);
    if (tail) return { src: tail.date, fromPartial: true };
    // 一度も着手していない番号 → 元の予定日（無ければ今日）
    const orig = originalChunks.find(c => n >= c.rangeStart && n <= c.rangeEnd);
    return { src: (orig && orig.date < todayStr) ? orig.date : todayStr, fromPartial: false };
  };

  const out = [];
  gaps.forEach(([gs, ge]) => {
    let runStart = gs, runOrigin = originOf(gs);
    for (let n = gs + 1; n <= ge + 1; n++) {
      const o = n <= ge ? originOf(n) : null;
      if (o && o.src === runOrigin.src && o.fromPartial === runOrigin.fromPartial) continue;
      // 当日に「途中まで」と入力した残りは、次の学習日へ
      const deferred = runOrigin.fromPartial && runOrigin.src === todayStr;
      out.push({
        date: deferred ? nextStudyDay : todayStr,
        rangeStart: runStart,
        rangeEnd: n - 1,
        ...idFields,
        isAdjusted: true,
        ...(deferred ? { isCarriedNew: true } : { carriedForward: true }),
        originalDate: runOrigin.src,
      });
      runStart = n; runOrigin = o;
    }
  });
  return out;
}

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
  const progressRecords = cfg.filterProgress(material.id);

  // [Step 1] dailyProgressから実績のみ構築
  const pastChunks = progressRecords
    .map(p => ({
      date: p.date,
      rangeStart: p.plannedStart,
      rangeEnd: p.actualEnd,          // doneToday 計算用に据え置き
      plannedEnd: p.plannedEnd,       // ★追加：途中完了の判定・再保存時の予定終了を保持
      progressEntryId: p.entryId,     // ★追加：保存時の複合キーをそのまま持たせる
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

  const effectiveWeekdays = (material.weekdays && material.weekdays.length > 0)
    ? material.weekdays
    : [0, 1, 2, 3, 4, 5, 6];
  // 今日の次の学習日（「途中まで」の残りの繰越先）
  const nextStudyDay = findNextStudyDay(todayStr, effectiveWeekdays);

  // ★ 最新の記録が「途中まで」か？（＝未完了の残りがある）
  //   その記録が今日のものなら、残りは当日中に置かず、次の学習日へ繰り越す。
  const isLatestPartial = latest.actualEnd < latest.plannedEnd;
  const isPartialToday  = isLatestPartial && latest.date === todayStr;
  // 前日以前の「途中まで」が残っている場合の繰越バッジ用（元の予定日）
  const carryOrigin = isLatestPartial ? latest.date : null;

  const remainingStart = latest.actualEnd + 1;
  // BUGFIX③: endNum が undefined/null の場合（古いデータ等）は 0 をガード値として使用し、
  //           NaN が後続処理（remaining 計算・while ループ）へ伝播するのを防ぐ。
  //           remainingEnd=0 のとき remaining<=0 が確実に true になり pastChunks を返す。
  const remainingEnd   = material.endNum ?? 0;
  const remaining      = remainingEnd - remainingStart + 1;

  // ★ 取りこぼし（入力されなかった範囲・途中の残り）を繰越チャンクとして必ず残す
  const leftoverChunks = buildLeftoverChunks(
    material, progressRecords, originalChunks, idFields,
    Math.min(latest.actualEnd, remainingEnd), todayStr, nextStudyDay
  );
  const head = [...pastChunks, ...leftoverChunks];

  if (remaining <= 0) return head; // 最終番号まで到達

  // [Step 2] 今日の残キャパシティを確認し、未完了分を今日から順に割り当て
  // ▼ BUGFIX Step 2: 直近の進捗レコードの残量（latest.plannedEnd - latest.actualEnd）ではなく
  //   「元々今日に予定されていた originalChunks の量（remainingStart 以降の部分）」を基準にする。
  //   繰越タスクを完了した場合は latest.plannedEnd - latest.actualEnd = 0 になってしまい、
  //   今日の元スケジュール分がキャパとして計上されなかった。
  const todayOriginalChunks = originalChunks.filter(c => c.date === todayStr);
  let todayCapacity = todayOriginalChunks.reduce((sum, c) => {
    const effectiveStart = Math.max(c.rangeStart, remainingStart);
    return sum + Math.max(0, c.rangeEnd - effectiveStart + 1);
  }, 0);

  // ▼ FIX: 元計画に「今日」の枠が無い場合でも、今日が学習曜日なら今日の枠を確保する。
  if (todayOriginalChunks.length === 0) {
    if (effectiveWeekdays.includes(parseISO(todayStr).getDay())) {
      const perDay = material.planMode === 'byAmount'
        ? (material.amountPerDay || 1)
        : (originalChunks.length > 0
            ? Math.ceil((material.endNum - material.startNum + 1) / originalChunks.length)
            : remaining);
      const doneToday = pastChunks
        .filter(c => c.date === todayStr)
        .reduce((sum, c) => sum + Math.max(0, c.rangeEnd - c.rangeStart + 1), 0);
      todayCapacity = Math.max(0, perDay - doneToday);
    }
  }

  // ★ 今日「途中まで」と入力した場合：今日の枠は使い切ったものとし、残りは今日に置かない
  //   （残りは次の学習日以降へ繰り越す）
  if (isPartialToday) todayCapacity = 0;

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
      // 前日以前の「途中まで」の続きなら、繰越バッジを付ける
      isCarriedNew: !!carryOrigin,
      ...(carryOrigin ? { originalDate: carryOrigin } : {})
    });
    futureStart = remainingStart + todayCount;
  }

  const futureRemaining = remainingEnd - futureStart + 1;
  if (futureRemaining <= 0) return [...head, ...todayChunks];

  // 「最初に割り当てる新規チャンク」＝未完了の残りの続き、のときだけ繰越バッジを付ける
  //   （完了済みの翌日分に誤って「繰越」が付かないよう、carryOrigin がある場合に限定）
  const isFirstCarried = (isFirst) => isFirst && todayChunks.length === 0 && !!carryOrigin;

  // [Step 3] 将来チャンクがない場合：新規タスクを生成して配分
  if (futureChunks.length === 0 || material.planMode === 'byAmount') {
    // 【修正】amountPerDay が未設定・NaN の場合、Math.max(1, NaN) が NaN になり
    //   チャンクの範囲が NaN になって以降の割り振りが止まっていた。数値でなければ 1 とみなす。
    const amountPerDay = Math.max(1,
      material.planMode === 'byAmount'
        ? (Number(material.amountPerDay) || 1)
        : originalChunks.length > 0
          ? Math.ceil((material.endNum - material.startNum + 1) / originalChunks.length)
          : futureRemaining
    );

    const newChunks = [];
    let cursor = futureStart;
    let searchFrom = todayStr;
    let safety = 0;
    while (cursor <= remainingEnd && safety++ < 3650) {
      const nextDate = findNextStudyDay(searchFrom, effectiveWeekdays);
      const count = Math.min(amountPerDay, remainingEnd - cursor + 1);
      const carried = isFirstCarried(newChunks.length === 0);
      newChunks.push({
        date: nextDate,
        rangeStart: cursor,
        rangeEnd: cursor + count - 1,
        ...idFields,
        isAdjusted: true,
        isCarriedNew: carried,
        ...(carried ? { originalDate: carryOrigin } : {})
      });
      cursor += count;
      searchFrom = nextDate;
    }
    return [...head, ...todayChunks, ...newChunks];
  }

  // [Step 4] 将来チャンクに残量を均等配分
  const base   = Math.floor(futureRemaining / futureChunks.length);
  const rem    = futureRemaining % futureChunks.length;
  let cursor   = futureStart;
  let firstAssigned = true;

  const newFutureChunks = futureChunks.flatMap((c, idx) => {
    const count      = base + (idx < rem ? 1 : 0);
    if (count <= 0) return []; // futureRemaining < futureChunks.length 時の不正チャンク防止
    const rangeStart = cursor;
    const rangeEnd   = cursor + count - 1;
    cursor = rangeEnd + 1;
    const carried = isFirstCarried(firstAssigned);
    firstAssigned = false;
    return [{ ...c, rangeStart, rangeEnd, isAdjusted: true,
              isCarriedNew: carried,
              ...(carried ? { originalDate: carryOrigin } : {}) }];
  });

  return [...head, ...todayChunks, ...newFutureChunks];
}

// ── 後方互換ラッパー：既存の呼び出し元（buildAllReviews等）を変更ゼロに保つ ──
function computeAdjustedChunksForEntry(entry) { return computeAdjustedSchedule('word', entry); }
function computeAdjustedRefSchedule(plan)     { return computeAdjustedSchedule('book', plan); }

/**
 * 全完了した場合の残り日数を計算（進捗が良い場合の通知用）
 * returns: 何日早く終わるか（0以下なら早まらない）
 */
function computeEarlyDays(entry, type, actualEnd) {
  const cfg = MATERIAL_CONFIGS[type];
  const material = cfg.resolveMaterial(entry);
  if (!material || actualEnd < material.endNum) return 0;

  const originalChunks = cfg.computeBaseSchedule(material);
  if (originalChunks.length === 0) return 0;

  const lastChunk = originalChunks[originalChunks.length - 1];
  const todayD = parseISO(todayISO());
  const lastD = parseISO(lastChunk.date);
  return Math.max(0, Math.round((lastD - todayD) / 86400000));
}

/* ───────── 学習範囲の割り振り（単語・参考書） ───────── */
/**
 * byAmount / byRange 両モード共通のチャンク生成コア。
 * extraFields に含めたいフィールドをオブジェクトで渡す（スプレッドで各チャンクにマージ）。
 */
function computeScheduleChunks(plan, extraFields = {}) {
  const start = parseISO(plan.startDate);
  const chunks = [];
  if (plan.planMode === 'byAmount') {
    // 【修正】amountPerDay が 0・負数・小数・未設定だと、範囲が進まないまま空のチャンクを
    //   大量に作ったり、小数の範囲になったりする。1以上の整数に正規化する。
    const perDay = Math.max(1, Math.floor(Number(plan.amountPerDay)) || 1);
    let cursor = plan.startNum, daysAdded = 0;
    while (cursor <= plan.endNum && daysAdded <= 3650) {
      const d = addDays(start, daysAdded++);
      if (!(plan.weekdays || []).includes(d.getDay())) continue;
      const count = Math.min(perDay, plan.endNum - cursor + 1);
      chunks.push({ date: formatISO(d), rangeStart: cursor, rangeEnd: cursor + count - 1, ...extraFields });
      cursor += count;
    }
  } else {
    // 過去のデータ（終了日が未設定のもの）は開始日から1週間とするための安全措置
    const end = plan.endDate ? parseISO(plan.endDate) : addDays(start, 6);
    const studyDates = [];
    let cur = new Date(start);
    // 【修正】学習曜日が1つも無い古いデータ＋遠い終了日の組み合わせで、
    //   studyDates が増えないまま延々と日付を進める（画面フリーズ）ことを防ぐ上限
    let dayGuard = 0;
    while (cur <= end && studyDates.length <= 3650 && dayGuard++ < 40000) {
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
