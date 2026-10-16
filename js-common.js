/* =========================================================
   js-common.js  ─  設定・共通の道具
   ---------------------------------------------------------
   【こんなときに、このファイルを開く】
    ・保存キー、復習間隔の初期値(1,3,7,14)、色などの「設定」を変えたい
    ・日付計算・データの保存/読込など、どの画面でも使う共通の道具を直したい
    ・単語/参考書の登録フォーム共通の動き（曜日チップ、編集モード、保存の流れ）を直したい
   【読み込み順】 ① 一番最初（他のファイルはここの内容を使います）
   ※ 中身のコードは、分割前の js-app.js と同一です（場所を移しただけ）。
========================================================= */

/* ───────── 設定・全体で使う変数・保存/ID生成の道具 ───────── */
const STORAGE_KEY = 'vocab-plan-entries';
const LEECH_KEY = 'vocab-leech-words';
const SCORE_KEY = 'vocab-score-records';
const ANALYSIS_KEY = 'vocab-weakness-analysis';
const DAILY_PROGRESS_KEY = 'vocab-daily-progress'; // 日別進捗記録
const MONTH_GOAL_KEY = 'vocab-month-goal'; // 今月の目標
const WEEKDAYS = ['日','月','火','水','木','金','土'];
// 復習キーの「日付移動済みサフィックス」を検出・除去するための共通正規表現（例: xxx_moved_2026-01-01）
const MOVED_KEY_SUFFIX_RE = /_moved_\d{4}-\d{2}-\d{2}$/;
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
  try {
    const r = localStorage.getItem(key);
    if (!r) return fallback;
    const v = JSON.parse(r);
    // fallback が配列のキーは、配列以外（{} や null など壊れた値）を受け取らない。
    // 受け取ると forEach / new Set 等で例外になり、起動処理が途中で止まって画面が空白になる。
    if (Array.isArray(fallback)) return Array.isArray(v) ? v : fallback;
    return v ?? fallback;
  }
  catch(e) { return fallback; }
}
// 【修正】保存に失敗（容量超過・プライベートブラウズ等）しても無言のままだと、
//   画面上は登録できたように見えるのにリロードで消えてしまう。失敗を true/false で返し、
//   初回のみ利用者へ知らせる。
let _storageErrorNotified = false;
function saveToStorage(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); return true; }
  catch(e) {
    console.error('Storage error:', e);
    if (!_storageErrorNotified) {
      _storageErrorNotified = true;
      alert('データの保存に失敗しました。ブラウザの保存容量がいっぱい、またはプライベートブラウズ中の可能性があります。このままだと、入力した内容がページを閉じると消えてしまいます。');
    }
    return false;
  }
}
// ──────────────────────────────────────────────────────────────

// ── ID生成ヘルパー ────────────────────────────────────────────
// crypto.randomUUID() はセキュアコンテキスト（HTTPS または localhost）でのみ
// 利用可能なため、HTTP環境や file:// で開いた場合は関数自体が存在せず
// 例外が発生する。利用可能なら randomUUID を使い、そうでなければ
// タイムスタンプ + ランダム文字列によるフォールバックでIDを生成する。
function genId(prefix){
  if (crypto?.randomUUID) return prefix + crypto.randomUUID();
  return prefix + Date.now() + '_' + Math.random().toString(36).slice(2);
}
// ──────────────────────────────────────────────────────────────

/* ───────── 日付の道具 ───────── */
function pad(n){ return String(n).padStart(2,'0'); }
function formatISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function parseISO(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function addDays(d, n){ const nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; }
function todayISO(){ return formatISO(new Date()); }

// 【追加】DOM の準備ができたら実行する。すでに準備済みなら即実行する。
//   （window.addEventListener('DOMContentLoaded', …) だけだと、スクリプトが後から
//    読み込まれた場合に一度も実行されず、フォームが初期化されないため）
function onDomReady(fn){
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

/* ───────── 曜日・復習間隔のチップ（単語/参考書共通） ───────── */
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

/* ───────── 登録済みエントリ一覧の共通描画（単語/参考書共通） ───────── */
// ── 登録済みエントリの一覧描画（単語・参考書共通ファクトリ）────────────
// カード生成・編集/削除ボタンへのイベント付与という共通の骨組みを1本化し、
// ラベル文言・削除確認の有無など型固有の差分だけを cfg のフック関数に委譲する。
function renderEntryCardList(cfg){
  const list = document.getElementById(cfg.listId);
  if(!list) return;
  list.innerHTML = '';
  const items = cfg.getItems();
  if(items.length === 0) return;

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'entry-item';
    el.classList.toggle('is-editing', item.id === cfg.getEditingId());
    const editExtra = cfg.editBtnExtraClass ? ` ${cfg.editBtnExtraClass}` : '';
    const delExtra = cfg.delBtnExtraClass ? ` ${cfg.delBtnExtraClass}` : '';
    el.innerHTML = `
      <div>
        <span class="rng">${cfg.buildLabel(item)}</span>
        <div class="meta">${cfg.buildMeta(item)}</div>
      </div>
      <div class="entry-actions">
        <button class="edit-btn${editExtra}" data-id="${item.id}">編集</button>
        <button class="del-btn${delExtra}" data-id="${item.id}">削除</button>
      </div>
    `;
    list.appendChild(el);
  });

  list.querySelectorAll(cfg.editBtnSelector).forEach(btn => {
    btn.addEventListener('click', () => cfg.onEdit(btn.dataset.id));
  });
  list.querySelectorAll(cfg.delBtnSelector).forEach(btn => {
    btn.addEventListener('click', () => cfg.onDelete(btn.dataset.id));
  });
}

/* ───────── フォーム状態管理の共通部品（単語/参考書共通） ───────── */
// ── フォーム状態管理の共通ファクトリ（単語・参考書共通）────────────────
// getXxxFormState / setXxxFormState / startEditXxx / exitXxxEditMode / cancelEditXxx の
// 5関数は、DOM要素IDのプレフィックス（refの有無）以外ほぼ同一処理のため、
// MATERIAL_CONFIGS と同じ設計思想でIDマッピング等を cfg として渡すファクトリに統合する。
function createFormController(cfg){
  const controller = {
    // 現在のフォーム入力内容を取得（キャンセル時の復元・編集開始時の退避に使用）
    getFormState(){
      return {
        planMode: document.querySelector(`input[name="${cfg.planModeName}"]:checked`)?.value || 'byRange',
        bookName: document.getElementById(cfg.fields.bookName)?.value ?? '',
        startNum: document.getElementById(cfg.fields.startNum).value,
        endNum: document.getElementById(cfg.fields.endNum).value,
        startDate: document.getElementById(cfg.fields.startDate).value,
        endDate: document.getElementById(cfg.fields.endDate).value,
        amountPerDay: document.getElementById(cfg.fields.amountPerDay).value,
        weekdays: getCheckedValues(cfg.fields.weekdayRow),
        intervals: getCheckedValues(cfg.fields.intervalRow),
      };
    },
    // スナップショット（または既存エントリの値）をフォームへ反映する
    setFormState(state){
      if (!state) return;
      const modeRadio = document.querySelector(`input[name="${cfg.planModeName}"][value="${state.planMode}"]`);
      if (modeRadio) {
        modeRadio.checked = true;
        modeRadio.dispatchEvent(new Event('change')); // 表示切替（既存の change ハンドラを再利用）
      }
      const bookNameEl = document.getElementById(cfg.fields.bookName);
      if (bookNameEl) bookNameEl.value = state.bookName ?? '';
      document.getElementById(cfg.fields.startNum).value = state.startNum ?? '';
      document.getElementById(cfg.fields.endNum).value = state.endNum ?? '';
      document.getElementById(cfg.fields.startDate).value = state.startDate ?? '';
      document.getElementById(cfg.fields.endDate).value = state.endDate ?? '';
      document.getElementById(cfg.fields.amountPerDay).value = state.amountPerDay ?? '';
      setCheckedValues(cfg.fields.weekdayRow, state.weekdays || []);
      setCheckedValues(cfg.fields.intervalRow, state.intervals || []);
    },
    // 「編集」ボタン押下時：フォームに既存エントリの内容を読み込み、編集モードに入る
    startEdit(id){
      const entry = cfg.getEntries().find(e => e.id === id);
      if (!entry) return;

      // 今フォームに入っている内容を退避（キャンセルされた場合に戻すため）
      // 【修正】すでに別の項目を編集中の場合は、最初に退避した内容を上書きしない
      //   （上書きすると、キャンセルしても「直前に編集していた別項目の内容」がフォームに残ってしまう）
      if (!cfg.getSnapshot()) cfg.setSnapshot(controller.getFormState());

      // 【修正】古いデータ（planMode 未設定）は「期間指定」として扱う。
      //   以前は planMode が undefined のためラジオが更新されず、直前の選択のまま編集が始まっていた。
      //   終了日が無い古い期間指定データは、計算側（開始日から1週間）と同じ終了日を補う。
      const editPlanMode = entry.planMode || 'byRange';
      const editEndDate = (editPlanMode === 'byRange' && !entry.endDate && entry.startDate)
        ? formatISO(addDays(parseISO(entry.startDate), 6))
        : entry.endDate;

      controller.setFormState({
        planMode: editPlanMode,
        bookName: entry.bookName,
        startNum: entry.startNum,
        endNum: entry.endNum,
        startDate: entry.startDate,
        endDate: editEndDate,
        amountPerDay: entry.amountPerDay,
        weekdays: entry.weekdays,
        intervals: entry.intervals,
      });

      cfg.setEditingId(id);
      const errorEl = document.getElementById(cfg.errorElId);
      if (errorEl) errorEl.textContent = '';

      const actionBtn = document.getElementById(cfg.actionBtnId);
      if (actionBtn) actionBtn.textContent = '✅ 変更を保存';
      const cancelBtn = document.getElementById(cfg.cancelBtnId);
      if (cancelBtn) cancelBtn.style.display = '';

      // 設定パネルを開いてフォームまでスクロール（閉じていても編集内容が見えるように）
      let scrollTarget = null;
      cfg.detailsIds.forEach((detailsId, idx) => {
        const detailsEl = document.getElementById(detailsId);
        if (detailsEl) {
          detailsEl.open = true;
          if (idx === 0) scrollTarget = detailsEl;
        }
      });
      scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' });

      cfg.renderList(); // 編集中の行をハイライトするため再描画
    },
    // ボタン表示・状態だけを新規追加モードへ戻す（フォーム内容には触れない）
    exitEditMode(){
      cfg.setEditingId(null);
      cfg.setSnapshot(null);
      const actionBtn = document.getElementById(cfg.actionBtnId);
      if (actionBtn) actionBtn.textContent = cfg.defaultActionText;
      const cancelBtn = document.getElementById(cfg.cancelBtnId);
      if (cancelBtn) cancelBtn.style.display = 'none';
    },
    // 「編集をキャンセル」ボタン押下時：フォームを編集前の状態に戻す
    cancelEdit(){
      const snapshot = cfg.getSnapshot();
      controller.exitEditMode();
      controller.setFormState(snapshot);
      cfg.renderList();
    },
  };
  return controller;
}

/* ───────── 登録処理の共通化の説明 ───────── */
// ── 登録処理（バリデーション＋保存）の共通化 ────────────────────────
// handleAdd（単語）と saveRefPlanBtn クリックハンドラ（参考書）は、
// エラー表示・必須チェック・byAmount/byRange分岐・編集/新規判定のロジックが
// ほぼ同一のため、共通保存関数 handleSaveEntry に処理の骨組みを抽出する。
// 検証ルール・入力値の読み方は型ごとに差があるため、それぞれの
// buildAndValidateXxxEntry に閉じ込め、cfg のフックとして渡す。

/* ───────── 登録フォームの共通保存処理（単語/参考書共通） ───────── */
/**
 * 登録フォームの共通保存処理（単語・参考書共通）。
 * エラー表示のクリア → バリデーション → 編集/新規判定 → 保存 → 再描画、という
 * 共通の流れを1本化し、型固有の差分は cfg のフィールド・フック関数に委譲する。
 */
async function handleSaveEntry(cfg){
  const errorEl = document.getElementById(cfg.errorElId);
  if (errorEl) errorEl.textContent = '';
  const showError = (msg) => { if (errorEl) errorEl.textContent = msg; else alert(msg); };

  const built = cfg.buildAndValidate(showError);
  if (!built) return; // 検証エラー（showError内で表示済み）

  const { newFields } = built;
  const list = cfg.getList();
  const editingId = cfg.getEditingId();

  // 【修正】編集対象がすでに存在しない場合（別タブで削除された等）、以前は何も保存されないまま
  //   「保存した」ように見えていた。その場合は新規追加として扱う。
  const isEditing = !!editingId && list.some(item => item.id === editingId);

  if (isEditing) {
    // 編集モード：IDを維持したまま内容だけ差し替える
    // （IDを変えると復習履歴・進捗記録との紐付けが切れてしまうため）
    cfg.setList(list.map(item => item.id === editingId ? cfg.applyEdit(item, newFields) : item));
    cfg.exitEditMode();
  } else {
    if (editingId) cfg.exitEditMode(); // 編集対象が消えていた場合は編集モードを解除
    cfg.setList([...list, { ...newFields, id: genId(cfg.idPrefix) }]);
  }

  await cfg.save();
  cfg.render();
  cfg.afterSave?.();
}

/* ───────── HTMLエスケープの道具 ───────── */
function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
