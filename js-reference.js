/* =========================================================
   js-reference.js  ─  ②参考書スケジュール設定タブ
   ---------------------------------------------------------
   【こんなときに、このファイルを開く】
    ・「参考書スケジュール設定」タブの登録・編集・一覧の動きを直したい
    ・参考書の登録時の入力チェック（エラー文言など）を直したい
   【読み込み順】 ④ js-common.js の後
   ※ 中身のコードは、分割前の js-app.js と同一です（場所を移しただけ）。
========================================================= */

/* ───────── 参考書スケジュール管理（登録・保存・一覧・編集） ───────── */
/* =========================================================
   参考書スケジュール管理ロジック
========================================================= */

// ① 初期化（今日の日付をセットし、保存されたデータを読み込む）
// 【修正】onDomReady を使い、スクリプトが DOMContentLoaded 後に読み込まれても初期化が実行されるようにする
onDomReady(() => {
  const refStartDateInput = document.getElementById('refStartDate');
  if(refStartDateInput) {
    refStartDateInput.value = todayISO();
  }

  // 学習する曜日のチップを生成（単語スケジュールと同じ仕組みを再利用）
  buildWeekdayChips('refWeekdayRow', DEFAULT_WEEKDAYS);
  // 復習インターバルは進捗入力時に DEFAULT_INTERVALS で自動生成するため、チップ選択UIは不要
  buildIntervalChips('refIntervalRow');

  // 割り振り方法（曜日から設定 / 1日あたりの量から設定）の切り替え
  document.querySelectorAll('input[name="refPlanMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isByAmount = e.target.value === 'byAmount';
      document.getElementById('refAmountFieldWrap').style.display = isByAmount ? 'block' : 'none';
      document.getElementById('refEndDateWrap').style.display = isByAmount ? 'none' : 'block';
    });
  });
  // 【追加】初期表示でも、選択中の割り振り方法に合わせて入力欄の表示を揃える
  document.querySelector('input[name="refPlanMode"]:checked')?.dispatchEvent(new Event('change'));

  // loadRefEntries() / renderIntegratedSchedule() / renderRefTodayCard() は
  // init() → loadRefEntries() → renderRefSchedule() → renderRefTodayCard() の
  // ルートで既にカバーされているため、ここでの呼び出しは不要（二重実行・競合防止）

  // ③ 「スケジュールを登録」ボタンが押された時の処理
  // バリデーション・保存・再描画の骨組みは handleSaveEntry（単語と共通）に委譲し、
  // ここでは参考書固有の検証ロジックと完了後処理だけを渡す。
  const saveRefPlanBtn = document.getElementById('saveRefPlanBtn');
  if (saveRefPlanBtn) {
    saveRefPlanBtn.addEventListener('click', () => {
      handleSaveEntry({
        errorElId: 'refErrorMsg',
        buildAndValidate: buildAndValidateRefEntry,
        getList: () => refEntries,
        setList: (arr) => { refEntries = arr; },
        getEditingId: () => editingRefEntryId,
        exitEditMode: exitRefEditMode,
        // 参考書は編集時、旧プランをスプレッドせず新しいフィールド一式に置き換える
        // （byAmount/byRangeの切替時に古いendDate/amountPerDayが残らないようにするため）
        applyEdit: (item, newFields) => {
          // ★修正：範囲（開始・終了ページ）を変えた場合、旧範囲に基づく進捗記録を破棄する
          if (item.startNum !== newFields.startNum || item.endNum !== newFields.endNum) {
            dailyProgress = dailyProgress.filter(p =>
              !(p.type === 'book' && (p.planId || p.entryId) === item.id));
            saveDailyProgress();
          }
          return { ...newFields, id: item.id };
        },
        idPrefix: 'ref_',
        save: saveRefEntries,
        render: renderRefSchedule,
        afterSave: () => {
          // 入力欄をクリア（教材名・ページ番号のみ）
          document.getElementById('refBookName').value = '';
          document.getElementById('refStartPage').value = '';
          document.getElementById('refEndPage').value = '';

          // 登録完了後：設定アコーディオンを閉じて「今日の確認」に注目させる
          const settingDetails = document.getElementById('refSettingDetails');
          if (settingDetails) settingDetails.open = false;
        },
      });
    });
  }

  document.getElementById('cancelRefEditBtn')?.addEventListener('click', cancelEditRefEntry);
});

// ①-2 参考書スケジュールの計算（単語スケジュールのcomputeChunksForEntryと同じ考え方）
// planMode === 'byAmount' : 1日あたりの量を指定 → 終了日は自動計算
// planMode === 'byRange'  : 開始日〜終了日と学習曜日を指定 → 1日あたりの量は自動計算
// ② データの保存と読み込み
/**
 * フォーム入力を検証し、保存用フィールド一式を返す（参考書用）。
 * 検証NGの場合は showError で表示のうえ null を返す。
 */
function buildAndValidateRefEntry(showError){
  const bookName = document.getElementById('refBookName').value.trim();
  const startNum = parseInt(document.getElementById('refStartPage').value, 10);
  const endNum = parseInt(document.getElementById('refEndPage').value, 10);
  const startDate = document.getElementById('refStartDate').value;
  const planMode = document.querySelector('input[name="refPlanMode"]:checked').value;
  const weekdays = getCheckedValues('refWeekdayRow');
  const intervals = getCheckedValues('refIntervalRow');

  if (!bookName || isNaN(startNum) || isNaN(endNum) || startNum < 0 || endNum < 0 || !startDate) {
    showError('すべての項目を正しく入力してください。');
    return null;
  }
  if (startNum > endNum) {
    showError('開始ページは終了ページ以下の数値を入力してください。');
    return null;
  }
  if (weekdays.length === 0) {
    showError('学習する曜日を1つ以上選んでください。');
    return null;
  }
  if (intervals.length === 0) {
    showError('復習のタイミングを1つ以上選んでください。');
    return null;
  }

  const newPlan = {
    bookName: bookName,
    startNum: startNum,
    endNum: endNum,
    startDate: startDate,
    weekdays: weekdays,
    intervals: intervals,
    planMode: planMode
  };

  if (planMode === 'byAmount') {
    const amount = parseInt(document.getElementById('refAmountPerDay').value, 10);
    if (!amount || amount <= 0) {
      showError('1日あたり進める量を正しく入力してください。');
      return null;
    }
    newPlan.amountPerDay = amount;
  } else {
    const endDate = document.getElementById('refEndDate').value;
    if (!endDate) {
      showError('終了日を選択してください。');
      return null;
    }
    if (parseISO(endDate) < parseISO(startDate)) {
      showError('終了日は開始日以降の日付にしてください。');
      return null;
    }
    newPlan.endDate = endDate;
  }

  // 事前にスケジュールを計算し、該当日がなければ登録前に知らせる
  if (computeRefSchedule(newPlan).length === 0) {
    showError('指定した期間・曜日では学習日がありません。設定を見直してください。');
    return null;
  }

  return { newFields: newPlan };
}

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
  renderEntryCardList({
    listId: 'refEntryList',
    getItems: () => refEntries,
    getEditingId: () => editingRefEntryId,
    editBtnExtraClass: 'ref-edit-btn',
    delBtnExtraClass: 'ref-del-btn',
    editBtnSelector: '.ref-edit-btn',
    delBtnSelector: '.ref-del-btn',
    buildLabel: (plan) => `${escapeHtml(plan.bookName)}　${plan.startNum}〜${plan.endNum}`,
    buildMeta: (plan) => {
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
      return `開始日 ${plan.startDate} ／ 学習日: ${wdLabel || '―'} ／ ${calcInfo} ／ 復習: ${(plan.intervals ?? []).join('・')}日後`;
    },
    onEdit: (id) => startEditRefEntry(id),
    onDelete: (id) => {
      if (!confirm('この参考書のスケジュールを削除しますか？')) return;
      // 編集中の項目が削除された場合は編集モードを解除しておく（不整合防止）
      if (editingRefEntryId === id) exitRefEditMode();
      refEntries = refEntries.filter(p => p.id !== id);
      saveRefEntries();
      renderRefSchedule();
    },
  });
}

// ── 参考書スケジュールの編集モード ────────────────────────────
// 単語版と同じ createFormController ファクトリを、参考書用のID・状態変数で利用する。
const refFormController = createFormController({
  planModeName: 'refPlanMode',
  fields: {
    bookName: 'refBookName',
    startNum: 'refStartPage',
    endNum: 'refEndPage',
    startDate: 'refStartDate',
    endDate: 'refEndDate',
    amountPerDay: 'refAmountPerDay',
    weekdayRow: 'refWeekdayRow',
    intervalRow: 'refIntervalRow',
  },
  getEntries: () => refEntries,
  setEditingId: (id) => { editingRefEntryId = id; },
  getSnapshot: () => refFormSnapshot,
  setSnapshot: (snapshot) => { refFormSnapshot = snapshot; },
  errorElId: 'refErrorMsg',
  actionBtnId: 'saveRefPlanBtn',
  defaultActionText: 'スケジュールを生成して登録',
  cancelBtnId: 'cancelRefEditBtn',
  detailsIds: ['refSettingDetails'],
  renderList: () => renderRefEntryList(),
});

function getRefFormState(){ return refFormController.getFormState(); }
function setRefFormState(state){ refFormController.setFormState(state); }
function startEditRefEntry(id){ refFormController.startEdit(id); }
function exitRefEditMode(){ refFormController.exitEditMode(); }
function cancelEditRefEntry(){ refFormController.cancelEdit(); }

// ⑤ 参考書タブ全体の再描画（登録リスト＋今日やること）
function renderRefSchedule() {
  renderRefEntryList();
  refreshAllSchedules();
  renderRefTodayCard();
}
