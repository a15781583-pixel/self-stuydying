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
  saveToStorage(STORAGE_KEY, entries);
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
      // 編集中の項目が削除された場合は編集モードを解除しておく（不整合防止）
      if (editingEntryId === id) exitEntryEditMode();
      entries = entries.filter(e => e.id !== id);
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

  if(!startNum || !endNum || endNum < startNum){
    showError('開始番号・終了番号を正しく入力してください（終了番号は開始番号以上）。'); return null;
  }
  if(!startDate){ showError('開始日を選択してください。'); return null; }

  // 終了日のバリデーションを追加
  if(planMode === 'byRange') {
    if(!endDate){ showError('終了日を選択してください。'); return null; }
    if(new Date(endDate) < new Date(startDate)){ showError('終了日は開始日以降の日付にしてください。'); return null; }
  }

  if(weekdays.length === 0){ showError('学習する曜日を1つ以上選んでください。'); return null; }
  if(intervals.length === 0){ showError('復習のタイミングを1つ以上選んでください。'); return null; }
  if(planMode === 'byAmount' && (!amountPerDay || amountPerDay <= 0)){
    showError('1日あたりの単語数を正しく入力してください。'); return null;
  }

  const newFields = { bookName, startNum, endNum, startDate, endDate, weekdays, intervals, planMode, amountPerDay };

  // 事前にスケジュールを計算し、該当する学習日が1日もなければ登録前に知らせる（参考書側の登録と同じ検証）。
  // 例：開始日〜終了日の間に、選んだ学習曜日が1日も含まれない場合。
  // この検証がないと、登録一覧には出るのにスケジュールには1件も出ない状態になってしまう。
  if (computeChunksForEntry(newFields).length === 0) {
    showError('指定した期間・曜日では学習日がありません。開始日〜終了日の間に、選んだ学習曜日が含まれるよう設定を見直してください。');
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
  });
}