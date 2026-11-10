/* =========================================================
   js-word.js  ─  ①単語スケジュール設定タブ
   ---------------------------------------------------------
   【こんなときに、このファイルを開く】
    ・「単語スケジュール設定」タブの登録・編集・一覧の動きを直したい
    ・単語の登録時の入力チェック（エラー文言など）を直したい
   【読み込み順】 ③ js-common.js の後
   ※ 中身のコードは、分割前の js-app.js と同一です（場所を移しただけ）。
========================================================= */

/* ───────── 単語データの保存・読込 ───────── */
async function loadEntries(){
  entries = loadFromStorage(STORAGE_KEY);
}
async function saveEntries(){
  return saveToStorage(STORAGE_KEY, entries);
}

/* ───────── 登録済み単語スケジュールの一覧表示 ───────── */
function renderEntryList(){
  renderEntryCardList({
    listId: 'entryList',
    getItems: () => entries,
    getEditingId: () => editingEntryId,
    editBtnExtraClass: '',
    delBtnExtraClass: '',
    editBtnSelector: '.edit-btn',
    delBtnSelector: '.del-btn',
    buildLabel: (entry) => `${escapeHtml(entry.bookName || '単語')}　${entry.startNum}〜${entry.endNum}`,
    buildMeta: (entry) => {
      const wdLabel = (entry.weekdays || []).slice().sort((a,b)=>a-b).map(i=>WEEKDAYS[i]).join('・');
      // 期間の表示をスマートに分岐
      let modeText = '';
      if (entry.planMode === 'byAmount') {
        modeText = `開始日 ${entry.startDate} (1日${entry.amountPerDay}単語)`;
      } else {
        modeText = entry.endDate ? `${entry.startDate} 〜 ${entry.endDate}` : `開始日 ${entry.startDate} (1週間)`;
      }
      // 検証追加前に登録された分も気づけるよう、学習日が1日もない登録には警告を付ける（参考書側の一覧と同様）
      const noStudyDayWarn = computeChunksForEntry(entry).length === 0
        ? ' ／ ⚠️ 該当する学習日がありません（編集で期間・曜日を見直してください）' : '';
      return `${modeText} ／ 学習日: ${wdLabel} ／ 復習: ${(entry.intervals ?? []).join('・')}日後${noStudyDayWarn}`;
    },
    onEdit: (id) => startEditEntry(id),
    onDelete: async (id) => {
      // 【修正】参考書側と同様に、誤クリックでスケジュールが消えないよう確認する
      if (!confirm('この単語のスケジュールを削除しますか？')) return;
      // 編集中の項目が削除された場合は、編集前のフォームへ戻して編集モードを解除する
      // （戻さないと、削除した内容がフォームに残ったまま再登録できてしまう）
      if (editingEntryId === id) cancelEditEntry();
      entries = entries.filter(e => e.id !== id);
      // 削除した単語に紐づく進捗記録・復習の完了記録も取り除く
      purgeMaterialData('word', id);
      await saveEntries();
      renderAll();
    },
  });
}

/* ───────── 単語スケジュールの編集モード ───────── */
// ── 単語スケジュールの編集モード ──────────────────────────────
const wordFormController = createFormController({
  planModeName: 'planMode',
  fields: {
    bookName: 'wordBookName',
    startNum: 'startNum',
    endNum: 'endNum',
    startDate: 'startDate',
    endDate: 'endDate',
    amountPerDay: 'amountPerDay',
    weekdayRow: 'weekdayRow',
    intervalRow: 'intervalRow',
  },
  getEntries: () => entries,
  setEditingId: (id) => { editingEntryId = id; },
  getSnapshot: () => entryFormSnapshot,
  setSnapshot: (snapshot) => { entryFormSnapshot = snapshot; },
  errorElId: 'errorMsg',
  actionBtnId: 'addBtn',
  defaultActionText: 'この範囲をスケジュールに追加',
  cancelBtnId: 'cancelEditBtn',
  detailsIds: ['setup', 'rangeRegisterDetails'], // ★①範囲登録の折りたたみも含めて開く
  renderList: () => renderEntryList(),
});

function getPlanFormState(){ return wordFormController.getFormState(); }
function setPlanFormState(state){ wordFormController.setFormState(state); }
function startEditEntry(id){ wordFormController.startEdit(id); }
function exitEntryEditMode(){ wordFormController.exitEditMode(); }
function cancelEditEntry(){ wordFormController.cancelEdit(); }
function finishEntryEditAfterSave(){ wordFormController.finishEditAfterSave(); }

/* ───────── 単語登録の入力チェック ───────── */
/**
 * フォーム入力を検証し、保存用フィールド一式を返す（単語用）。
 * 検証NGの場合は showError で表示のうえ null を返す。
 */
function buildAndValidateWordEntry(showError){
  // ★ 参考書と設計を共通化：教材名（任意項目、未入力なら「単語」として扱う）
  const bookName = document.getElementById('wordBookName')?.value.trim() || '';
  const startNum = Number(document.getElementById('startNum').value);
  const endNum = Number(document.getElementById('endNum').value);
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value; // 追加
  const weekdays = getCheckedValues('weekdayRow');
  const intervals = getCheckedValues('intervalRow');
  const planMode = document.querySelector('input[name="planMode"]:checked').value;
  const amountPerDay = Number(document.getElementById('amountPerDay').value);

  // 【修正】小数（例: 1.5）や 0・負数を弾く。小数が通ると範囲・復習キーが小数になり計算が崩れる
  if(!Number.isInteger(startNum) || !Number.isInteger(endNum) || startNum < 1 || endNum < startNum){
    showError('開始番号・終了番号を正しく入力してください（1以上の整数で、終了番号は開始番号以上）。'); return null;
  }
  if(!startDate){ showError('開始日を選択してください。'); return null; }

  // 終了日のバリデーションを追加
  if(planMode === 'byRange') {
    if(!endDate){ showError('終了日を選択してください。'); return null; }
    if(new Date(endDate) < new Date(startDate)){ showError('終了日は開始日以降の日付にしてください。'); return null; }
  }

  if(weekdays.length === 0){ showError('学習する曜日を1つ以上選んでください。'); return null; }
  if(intervals.length === 0){ showError('復習のタイミングを1つ以上選んでください。'); return null; }
  if(planMode === 'byAmount' && (!Number.isInteger(amountPerDay) || amountPerDay <= 0)){
    showError('1日あたりの単語数を正しく入力してください。'); return null;
  }

  // 使わない側の項目は保存しない（モード切替後に古い終了日・1日の量が復元されるのを防ぐ。参考書側と同じ扱い）
  const newFields = {
    bookName, startNum, endNum, startDate, weekdays, intervals, planMode,
    endDate: planMode === 'byRange' ? endDate : undefined,
    amountPerDay: planMode === 'byAmount' ? amountPerDay : undefined,
  };

  // 事前にスケジュールを計算し、該当する学習日が1日もなければ登録前に知らせる（参考書側の登録と同じ検証）。
  // 例：開始日〜終了日の間に、選んだ学習曜日が1日も含まれない場合。
  // この検証がないと、登録一覧には出るのにスケジュールには1件も出ない状態になってしまう。
  const previewChunks = computeChunksForEntry(newFields);
  if (previewChunks.length === 0) {
    showError('指定した期間・曜日では学習日がありません。開始日〜終了日の間に、選んだ学習曜日が含まれるよう設定を見直してください。');
    return null;
  }
  // 1日の量が少なすぎて（約10年分の上限で）終了番号まで割り振れない場合は、登録前に知らせる
  if (previewChunks[previewChunks.length - 1].rangeEnd < endNum) {
    showError('この設定では終了番号まで割り振れません。1日あたりの単語数を増やすか、範囲を分けて登録してください。');
    return null;
  }

  // 同じ教材名で番号が重なる登録があれば、重複して予定に並ぶ前に確認する
  const overlap = findOverlappingEntry(entries, bookName, startNum, endNum, editingEntryId, '単語');
  if (overlap && !confirm(`「${bookName || '単語'}」の ${overlap.startNum}〜${overlap.endNum} と範囲が重なっています。同じ範囲が重複してスケジュールされますが、登録しますか？`)) {
    return null;
  }

  return { newFields };
}

/* ───────── 「この範囲をスケジュールに追加」ボタンの処理 ───────── */
async function handleAdd(){
  await handleSaveEntry({
    errorElId: 'errorMsg',
    buildAndValidate: buildAndValidateWordEntry,
    getList: () => entries,
    setList: (arr) => { entries = arr; },
    getEditingId: () => editingEntryId,
    exitEditMode: exitEntryEditMode,
    // 【追加】編集保存後は、編集を始める前のフォーム内容へ戻す（復習間隔・曜日などの持ち越し防止）
    finishEditAfterSave: finishEntryEditAfterSave,
    // 【追加】範囲を変えると進捗記録が削除されるため、記録がある場合は保存前に確認する。
    //   開始日・期間・曜日・1日の量を変える場合も、復習の日付や完了状態がずれることがあるため確認する
    confirmEdit: (item, nf) => {
      if (!hasMaterialRecords('word', item.id)) return true;
      if (item.startNum !== nf.startNum || item.endNum !== nf.endNum) {
        return confirm('範囲（開始・終了番号）を変えると、この単語のこれまでの進捗記録が削除されます。続けますか？');
      }
      if (isScheduleShapeChanged(item, nf)) {
        return confirm('開始日・期間・曜日・1日の量を変えると、学習範囲の割り振りが変わり、復習の日付や完了状態がずれる場合があります。続けますか？');
      }
      return true;
    },
    applyEdit: (item, newFields) => {
      // ★修正：範囲（開始・終了番号）を変えた場合、旧範囲に基づく進捗記録を破棄する
      //   （残すと新範囲の外の番号が再配分されるため）
      if (item.startNum !== newFields.startNum || item.endNum !== newFields.endNum) {
        dailyProgress = dailyProgress.filter(p =>
          !(p.type === 'word' && (p.originEntryId || p.entryId) === item.id));
        saveDailyProgress();
      }
      return { ...item, ...newFields };
    },
    idPrefix: 'e_',
    save: saveEntries,
    render: renderAll,
    // 【修正】登録後は次の開始番号を自動入力し、終了番号を空にする（再クリックによる二重登録を防ぐ）
    afterSave: ({ wasEditing } = {}) => {
      if (wasEditing) return; // 編集保存では次の番号の自動入力をしない（編集前のフォームへ復元済み）
      const endEl = document.getElementById('endNum');
      const next = Number(endEl.value) + 1;
      document.getElementById('startNum').value = Number.isInteger(next) ? next : '';
      endEl.value = '';
    },
  });
}
