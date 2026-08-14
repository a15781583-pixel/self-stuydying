/* ===========================
   スター文字列生成ユーティリティ（重複削減）
=========================== */
function renderStars(rawScore) {
  const score = Math.min(Math.max(Number(rawScore) || 0, 0), 5);
  return { score, stars: '★'.repeat(score) + '☆'.repeat(5 - score) };
}

/* ===========================
   日付取得のヘルパー関数（新規追加）
=========================== */
function getLocalDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().split('T')[0];
}

// 1. 生徒データの読み込み（なければ初期データを生成）
function createDefaultStudentData(studentId) {
  return {
    studentId,
    createdAt: getLocalDate(),
    updatedAt: getLocalDate(),
    basicInfo: { name: '', grade: '', subjects: [], goal: '', initialConcerns: '' },
    lessonLogs: [],
    aiDiagnostics: [],
  };
}

function getStudentData(studentId) {
  const key = `student_data_${studentId}`;
  const jsonStr = localStorage.getItem(key);

  if (!jsonStr) return createDefaultStudentData(studentId);

  try {
    const data = JSON.parse(jsonStr);
    data.lessonLogs = Array.isArray(data.lessonLogs) ? data.lessonLogs : [];
    data.aiDiagnostics = Array.isArray(data.aiDiagnostics) ? data.aiDiagnostics : [];
    return data;
  } catch (e) {
    console.error("データのパースエラー:", e);
    // 返すだけにして保存はしない（既存データを壊さない）
    // _parseError フラグにより呼び出し側・saveStudentData 側で保存をスキップできる
    return { ...createDefaultStudentData(studentId), _parseError: true };
  }
}  

// 2. 生徒データの保存
function saveStudentData(studentData) {
  if (!studentData || !studentData.studentId) return;
  // パースエラー由来の空データが流れ込んでも既存データを上書きしない
  if (studentData._parseError) return;
  
  studentData.updatedAt = getLocalDate();
  
  const key = `student_data_${studentData.studentId}`;
  localStorage.setItem(key, JSON.stringify(studentData));
}

// 3. 授業ログ（日々の指導レポート）を追加して保存する関数
function addLessonLog(studentId, logData) {
  const data = getStudentData(studentId);
  
  const newLog = {
    logId: `log_${crypto.randomUUID()}`,
    date: logData.date || getLocalDate(),
    subject: logData.subject || '',
    unit: logData.unit || '',
    comprehension: parseComprehension(logData.comprehension),
    attitude: logData.attitude || '',
    instructorNotes: logData.instructorNotes || '',
    homeworkStatus: logData.homeworkStatus || '',
    lessonContent: logData.lessonContent || ''
  };

  data.lessonLogs.push(newLog);
  saveStudentData(data);
  return data;
}

// 4. 生成されたAI診断結果を履歴に追加して保存する関数
function addAIDiagnostics(studentId, aiResult) {
  const data = getStudentData(studentId);
  
  const newDiag = {
    diagId: `diag_${crypto.randomUUID()}`,
    date: getLocalDate(),
    ...aiResult
  };

  data.aiDiagnostics.push(newDiag);
  saveStudentData(data);
  return data;
}

// 5. 授業ログを削除する関数
function deleteLessonLog(studentId, logId) {
  const data = getStudentData(studentId);
  data.lessonLogs = data.lessonLogs.filter(l => l.logId !== logId);
  saveStudentData(data);
  return data;
}

// 6. 授業ログを更新する関数
function updateLessonLog(studentId, logId, updatedFields) {
  const data = getStudentData(studentId);
  const idx  = data.lessonLogs.findIndex(l => l.logId === logId);
  if (idx === -1) return data;
  data.lessonLogs[idx] = {
    ...data.lessonLogs[idx],   // logId などを保持
    ...updatedFields,
    comprehension: parseComprehension(updatedFields.comprehension),
  };
  saveStudentData(data);
  return data;
}

// 7. 授業ログのペイロードを生成するヘルパー関数
function buildLessonLogPayload(formData, lessonDate) {
  return {
    date:            lessonDate,
    subject:         formData.subjects,
    unit:            formData.scores,
    comprehension:   formData.comp,
    attitude:        formData.attitude,
    instructorNotes: formData.notes,
    lessonContent:   formData.lessonContent
  };
}

// 8. 授業ログを新規追加 or 更新する共通ヘルパー関数
function saveOrUpdateLessonLog(studentId, formData, lessonDate) {
  const payload = buildLessonLogPayload(formData, lessonDate);
  if (_editingLogId) {
    updateLessonLog(studentId, _editingLogId, payload);
    _editingLogId = null;
    _editingLog   = null;
    return 'updated';
  } else {
    addLessonLog(studentId, payload);
    return 'added';
  }
}

/* ===========================
   使用モデル
   gemini-3.7-flash（無料枠あり）
   ※ Google AI Studio で取得した APIキーを使用
   https://aistudio.google.com/app/apikey
=========================== */
const GEMINI_MODEL    = 'gemini-3.7-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;

/* ===========================
   localStorage キー定数
=========================== */
const STUDENTS_TABS_KEY  = 'app_students_tabs';
const STUDENTS_INDEX_KEY = 'app_students_index';

/* ===========================
   API通信用ヘルパー関数（自動リトライ機能付き）
=========================== */
async function fetchGeminiWithRetry(apiKey, requestBody, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const msg = errBody?.error?.message || `${response.status} ${response.statusText}`;
        
        // 503(サーバー高負荷) または 429(リクエスト過多) の場合のみリトライ
        if (response.status === 503 || response.status === 429) {
          if (i < maxRetries - 1) {
            console.warn(`API高負荷のため再試行します（${i + 1}回目）...`);
            // 待機時間を徐々に長くする (2秒 → 4秒)
            const waitTime = (i + 1) * 2000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue; // ループの最初に戻って再リクエスト
          }
        }
        // リトライ対象外のエラーにはフラグを付けて投げる
        const error = new Error(msg);
        error.isFatal = true;
        throw error;
      }

      // 成功した場合はJSONを返す
      return await response.json();
      
    } catch (err) {
      // isFatalフラグがある、または上限回数に達した場合はそのまま投げる
      if (err.isFatal || i === maxRetries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

/* ===========================
   Geminiレスポンスのパースヘルパー
=========================== */
function parseGeminiResponse(data) {
  if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('レスポンスがトークン上限に達しました。入力情報を減らすか、しばらく時間をおいて再試行してください。');
  }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('AIからのレスポンスを取得できませんでした。');
  try {
    return JSON.parse(rawText);
  } catch (e) {
    throw new Error('AIレスポンスの解析に失敗しました。しばらくしてから再試行してください。');
  }
}

/* ===========================
   クリップボードコピー共通ヘルパー
=========================== */
function copyToClipboard(text, btnId, originalHTML) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.innerHTML = '<i class="ti ti-check"></i> コピーしました';
    setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
  }).catch(() => showToast('コピーに失敗しました', 'error'));
}

/* ===========================
   フォームフィールド一覧
=========================== */
const FIELD_IDS = [
  'f-name', 'f-grade',
  'lesson-date',
  'f-comp',
  'f-attitude',
  'f-goal', 'f-concerns', 'f-notes',
  'f-lesson-content',
];

/* ===========================
   テスト種類の入力サジェスト候補
=========================== */
const TEST_TYPE_SUGGESTIONS = [
  '定期テスト', '実力テスト', '全統記述模試', '全統共通テスト模試', 
  '進研模試', '駿台模試', '駿台ベネッセ共通テスト模試', '全国統一高校生テスト', '全国統一中学生テスト', '共通テスト本番レベル模試', '冠模試', '英検', '漢検', '数検'
];

/* ===========================
   生徒データ管理
=========================== */
/** 理解度グラフの最後に渡したログを保持（リサイズ再描画用） */
let _chartLogs = null;
/** リサイズタイマーID（デバウンス用） */
let _chartResizeTimer = null;

let _editingLogId  = null;
let _editingLog    = null;  // バグ②修正: 編集中ログオブジェクトを保持し unit を引き継ぐ

let studentCounter = 1;
let currentIndex   = 0;
let students       = [];

function createTestEntry() {
  return { type: '', grade: '', date: '', scores: '' };
}

function createShortTermGoalEntry() {
  return { text: '', deadline: '' };
}

/**
 * students 配列の defaultName から最大番号を求め、
 * studentCounter を「最大番号 + 1」にリセットする共通ヘルパー。
 * initStudents / removeStudent / importData の3箇所で使用する。
 */
function resetStudentCounter() {
  const max = students.reduce((m, s) => {
    const match = (s.defaultName || '').match(/生徒\s*(\d+)/);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  studentCounter = max + 1;
}

function createStudent() {
  const num  = studentCounter++;
  const data = {};
  FIELD_IDS.forEach(id => { data[id] = ''; });
  data.subjects        = [];
  data.tests           = [createTestEntry()];
  data.shortTermGoals  = [createShortTermGoalEntry()];
  return {
    id:               Date.now() + Math.random(),
    defaultName:      `生徒 ${num}`,
    tabName:          `生徒 ${num}`,
    data,
    result:           null,          // AI診断レポート結果
    lessonPlanResult: null,          // 次回授業案の結果
    lastResultType:   'diagnosis',   // 'diagnosis' | 'lessonplan' — 右パネルに最後に表示した種類
    mode:             'profile',     // 'profile' | 'report' | 'history'
    modeInitialized:  false,         // 初回タブ表示時に detectMode() で上書きするフラグ
  };
}

/* ===========================
   タブ・基本情報の永続化
=========================== */

/**
 * students 配列と currentIndex を localStorage に保存する。
 * saveCurrentForm() やタブ操作のたびに呼び出すことで
 * ページリロード後もタブ一覧・入力内容を復元できる。
 * result / lessonPlanResult は容量節約のため保存しない
 * （AI診断の生ログは lessonLogs / aiDiagnostics に別途保存済み）。
 */
function saveStudentsTabs() {
  try {
    const toSave = students.map(s => ({
      id:              s.id,
      defaultName:     s.defaultName,
      tabName:         s.tabName,
      data:            s.data,
      mode:            s.mode,
      modeInitialized: s.modeInitialized,
      lastResultType:  s.lastResultType,
    }));
    localStorage.setItem(STUDENTS_TABS_KEY,  JSON.stringify(toSave));
    localStorage.setItem(STUDENTS_INDEX_KEY, String(currentIndex));
  } catch (e) {
    console.warn('タブ情報の保存に失敗しました:', e);
  }
}

/**
 * ページロード時に students 配列を localStorage から復元する。
 * 保存データがない場合は初期状態（「生徒 1」タブのみ）を生成する。
 */
function initStudents() {
  const saved = localStorage.getItem(STUDENTS_TABS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        students = parsed.map(t => ({
          id:              t.id !== undefined ? t.id : Date.now() + Math.random(),
          defaultName:     t.defaultName    || '生徒',
          tabName:         t.tabName        || t.defaultName || '生徒',
          data:            t.data           || {},
          result:          null,
          lessonPlanResult: null,
          lastResultType:  t.lastResultType || 'diagnosis',
          mode:            t.mode           || 'profile',
          modeInitialized: typeof t.modeInitialized === 'boolean' ? t.modeInitialized : false,
        }));
        // studentCounter を復元した生徒数より大きい値に設定し、番号重複を防ぐ
        resetStudentCounter();
        // currentIndex を復元（範囲外の場合は 0 にフォールバック）
        const savedIdx = parseInt(localStorage.getItem(STUDENTS_INDEX_KEY) || '0', 10);
        currentIndex = (Number.isFinite(savedIdx) && savedIdx >= 0 && savedIdx < students.length)
          ? savedIdx : 0;
        return;
      }
    } catch (e) {
      console.warn('タブ情報の復元に失敗しました:', e);
    }
  }
  // 保存データなし → 初期状態を生成
  students     = [createStudent()];
  currentIndex = 0;
}

/* ===========================
   Step 1: モード管理（フロー分岐）
=========================== */

/**
 * localStorageの授業ログ有無でモードを自動判別する。
 * lessonLogs が 1 件以上あれば 'report'、なければ 'profile' を返す。
 */
function detectMode(studentId) {
  const data = getStudentData(studentId);
  return (data && data.lessonLogs.length > 0) ? 'report' : 'profile';
}

/** サブナビゲーション用スタイルを <head> に一度だけ注入する */
function injectSubNavStyles() {
  if (document.getElementById('sub-nav-styles')) return;
  const style = document.createElement('style');
  style.id = 'sub-nav-styles';
  style.textContent = `
    .sub-nav {
      display: flex;
      gap: 4px;
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border, #e5e7eb);
      background: var(--bg, #fff);
    }
    .sub-nav-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 7px 4px;
      border: 1px solid var(--border, #d1d5db);
      border-radius: 8px;
      background: transparent;
      color: var(--text-muted, #6b7280);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .sub-nav-btn:hover {
      background: var(--surface-hover, #f3f4f6);
      color: var(--text, #111827);
    }
    .sub-nav-btn.active {
      background: var(--primary, #4f46e5);
      border-color: var(--primary, #4f46e5);
      color: #fff;
    }
    .history-empty {
      padding: 40px 16px;
      text-align: center;
      color: var(--text-muted, #9ca3af);
      font-size: 14px;
    }
    .history-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 16px 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
      border-bottom: 1px solid var(--border, #e5e7eb);
      margin: 0;
    }
    .history-card {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border, #f3f4f6);
    }
    .history-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      flex-wrap: wrap;
    }
    .history-date {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
    }
    .history-score {
      font-size: 12px;
      font-weight: 600;
      color: var(--primary, #4f46e5);
    }
    .history-subject {
      font-size: 11px;
      color: var(--text-muted, #6b7280);
      background: var(--surface-hover, #f3f4f6);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .history-comp {
      font-size: 11px;
      color: var(--text-muted, #6b7280);
    }
    .history-card-body {
      font-size: 12px;
      color: var(--text, #374151);
      line-height: 1.5;
    }
    #section-history {
      overflow-y: auto;
    }

    /* ── アコーディオン ── */
    .accordion-list {
      border-top: 1px solid var(--border, #e5e7eb);
    }
    .accordion-item {
      border-bottom: 1px solid var(--border, #e5e7eb);
    }
    .accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      cursor: pointer;
      gap: 8px;
      user-select: none;
      transition: background 0.15s;
    }
    .accordion-header:hover {
      background: var(--surface-hover, #f9fafb);
    }
    .accordion-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
      flex: 1;
    }
    .accordion-icon {
      font-size: 13px;
      color: var(--text-muted, #9ca3af);
      transition: transform 0.2s;
      flex-shrink: 0;
    }
    .accordion-item.is-open .accordion-icon {
      transform: rotate(90deg);
    }
    .accordion-body {
      display: none;
      padding: 4px 16px 12px 36px;
      font-size: 12px;
      color: var(--text, #374151);
      line-height: 1.6;
    }
    .accordion-item.is-open .accordion-body {
      display: block;
    }
    .accordion-field {
      margin-bottom: 4px;
    }
    .accordion-field-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
    }
    .accordion-comp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .accordion-comp-num {
      font-size: 11px;
      font-weight: 600;
      color: var(--primary, #4f46e5);
      white-space: nowrap;
    }
    .mini-bar {
      display: inline-block;
      width: 80px;
      height: 6px;
      background: var(--border, #e5e7eb);
      border-radius: 3px;
      overflow: hidden;
      vertical-align: middle;
    }
    .mini-bar-fill {
      display: block;
      height: 100%;
      background: var(--primary, #4f46e5);
      border-radius: 3px;
    }

    /* ── 直近AI診断バッジ ── */
    .diag-badge-wrapper {
      padding: 14px 16px 4px;
    }
    .diag-badge-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .diag-badge {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      border-radius: 12px;
      padding: 14px 16px;
      color: #fff;
      margin-bottom: 4px;
    }
    .diag-badge-score {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }
    .diag-badge-stars {
      font-size: 15px;
      letter-spacing: 2px;
      opacity: 0.95;
    }
    .diag-badge-num {
      font-size: 26px;
      font-weight: 700;
      line-height: 1;
    }
    .diag-badge-num small {
      font-size: 12px;
      font-weight: 400;
      opacity: 0.75;
    }
    .diag-badge-diff {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 20px;
      background: rgba(255,255,255,0.2);
    }
    .diag-badge-diff.down {
      background: rgba(0,0,0,0.18);
    }
    .diag-badge-comment {
      font-size: 12px;
      opacity: 0.9;
      line-height: 1.55;
      margin-bottom: 6px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .diag-badge-date {
      font-size: 10px;
      opacity: 0.65;
    }
    .diag-score-badge {
      font-size: 11px;
      font-weight: 600;
      background: var(--primary, #4f46e5);
      color: #fff;
      padding: 2px 8px;
      border-radius: 20px;
      flex-shrink: 0;
    }

    /* ── 理解度グラフ ── */
    .chart-container {
      padding: 4px 16px 8px;
    }
    #comp-chart {
      display: block;
      width: 100%;
    }
    .action-btn-danger {
      border-color: #fca5a5;
      color: #dc2626;
    }
    .action-btn-danger:hover {
      background: #fef2f2;
      border-color: #f87171;
      color: #b91c1c;
    }
  `;
  document.head.appendChild(style);
}

/** form-panel 上部にサブナビゲーションを挿入する */
function renderSubNav() {
  const panel = document.getElementById('form-panel');
  if (!panel) return;

  const existing = document.getElementById('sub-nav');
  if (existing) existing.remove();

  const nav = document.createElement('div');
  nav.id = 'sub-nav';
  nav.className = 'sub-nav';
  nav.innerHTML = `
    <button type="button" class="sub-nav-btn" data-mode="profile">
      <i class="ti ti-user"></i> 基本情報
    </button>
    <button type="button" class="sub-nav-btn" data-mode="report">
      <i class="ti ti-book"></i> 授業記録
    </button>
    <button type="button" class="sub-nav-btn" data-mode="history">
      <i class="ti ti-history"></i> 履歴
    </button>
  `;

  panel.insertBefore(nav, panel.firstChild);

  nav.querySelectorAll('.sub-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  updateSubNavActive(students[currentIndex]?.mode || 'profile');
}

/** サブナビのアクティブ状態を現在の mode に合わせて同期する */
function updateSubNavActive(mode) {
  document.querySelectorAll('#sub-nav .sub-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

/**
 * form-panel の直下子要素に data-section 属性を付与してセクションを分割する。
 * 初回のみ実行（data-sections-init 属性で二重実行を防止）。
 *
 * 基本情報（profile）: f-name / f-grade / f-goal / f-concerns / subjects
 * 授業記録（report） : f-comp / comp-scale / f-attitude / f-notes /
 *                     test-list / test-add-btn / gen-btn / api-key
 * 未分類の子要素は report に振り分ける。
 */
function initSections() {
  const panel = document.getElementById('form-panel');
  if (!panel || panel.hasAttribute('data-sections-init')) return;
  panel.setAttribute('data-sections-init', '1');

  // 履歴セクションを動的に追加
  if (!document.getElementById('section-history')) {
    const historySec = document.createElement('div');
    historySec.id = 'section-history';
    historySec.className = 'mode-section';
    panel.appendChild(historySec);
  }
}

/** mode に応じて form-panel 内のセクションを表示 / 非表示にする */
function showModeSection(mode) {
  const panel = document.getElementById('form-panel');
  if (!panel) return;

  [...panel.children].forEach(child => {
    if (child.id === 'sub-nav') return;

    if (child.id === 'section-history') {
      child.style.display = (mode === 'history') ? '' : 'none';
    } else if (mode === 'history') {
      child.style.display = 'none';
    } else if (mode === 'profile' && child.dataset.section === 'report') {
      // 基本情報タブでは report 専用要素を非表示
      child.style.display = 'none';
    } else if (mode === 'report' && child.dataset.section === 'profile') {
      // 【追加】授業記録タブでは profile 専用要素を非表示
      child.style.display = 'none';
    } else {
      child.style.display = '';
    }
  });

  if (mode === 'history') renderHistoryView();
}

/**
 * 生徒名が設定済みの場合、「生徒名」「学年」フィールドをロック（入力不可）にする。
 * 「授業日」「担当科目」は常に入力可能なまま維持する。
 * ロック解除は「変更」ボタンで一時的に可能。
 */
function updateBasicInfoLock(s) {
  const hasName   = (s.data['f-name'] || '').trim().length > 0;
  const nameInput   = document.getElementById('f-name');
  const gradeSelect = document.getElementById('f-grade');
  const unlockBtn   = document.getElementById('basic-info-unlock-btn');

  if (nameInput) {
    nameInput.disabled = hasName;
    nameInput.closest('.field')?.classList.toggle('field-locked', hasName);
  }
  if (gradeSelect) {
    gradeSelect.disabled = hasName;
    gradeSelect.closest('.field')?.classList.toggle('field-locked', hasName);
  }

  // 「変更」ボタンは生徒名が設定済みのときのみ表示
  if (unlockBtn) {
    unlockBtn.style.display = hasName ? '' : 'none';
  }
}

/** サブナビボタン押下時: フォームを保存してモードを切り替える */
function switchMode(mode) {
  // 編集中に report 以外へ切替する場合は確認を取る
  if (mode !== 'report' && _editingLogId) {
    if (!confirm('編集中の内容は保存されません。移動しますか？')) return;
    // 編集状態を解除し、フォームを生徒の基本データに戻してから保存する
    // （ログ編集中のデータ date/comp/attitude/notes が student.data に上書きされるのを防ぐ）
    _editingLogId = null;
    _editingLog   = null;
    restoreForm(students[currentIndex]);
  }
  saveCurrentForm();
  students[currentIndex].mode = mode;
  updateSubNavActive(mode);
  showModeSection(mode);
  updateEditModeUI(); 
}

/**
 * log.unit のテキスト表現（buildFormData() が生成するフォーマット）を
 * テストエントリーの配列 { type, grade, date, scores }[] に変換する。
 * 復元できない場合は空エントリー1件を返す。
 *
 * 想定フォーマット（buildFormData の scoresText）:
 *   [定期テスト / 対象: 高2 / 実施日: 2024-06-01]
 *   数学 75点、英語 80点
 *
 *   [全統記述模試]
 *   英語 偏差値 55.2
 */
function parseUnitToTestEntries(unitText) {
  if (!unitText || unitText === '未入力') {
    return [createTestEntry()];
  }

  // buildFormData が join('\n\n') したブロック単位で分割する
  const blocks  = unitText.split(/\n\n+/);
  const entries = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return null;

    const lines     = trimmed.split('\n');
    const firstLine = lines[0] || '';

    // ヘッダー行 "[type / 対象: grade / 実施日: date]" をパース
    const headerMatch = firstLine.match(/^\[(.+)\]$/);
    let type = '', grade = '', date = '';

    if (headerMatch) {
      headerMatch[1].split('/').map(p => p.trim()).forEach(part => {
        if (part.startsWith('対象:')) {
          grade = part.slice(3).trim();
        } else if (part.startsWith('実施日:')) {
          date = part.slice(4).trim();
        } else if (!type && !/^テスト\d+$/.test(part)) {
          // "テスト1" 等のフォールバックラベルは type として扱わない
          type = part;
        }
      });
      const scores = lines.slice(1).join('\n').trim();
      return { type, grade, date, scores };
    }

    // ヘッダーなし → ブロック全体を scores として扱う
    return { type: '', grade: '', date: '', scores: trimmed };
  }).filter(Boolean);

  return entries.length > 0 ? entries : [createTestEntry()];
}

function loadLogIntoReportForm(log) {
  // 授業日
  const dateEl = document.getElementById('lesson-date');
  if (dateEl) dateEl.value = log.date || '';

  // 担当科目チップ
  selectedSubjects.clear();
  (log.subject || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean)
    .forEach(v => selectedSubjects.add(v));
  document.querySelectorAll('#subjects .chip').forEach(chip => {
    chip.classList.toggle('selected', selectedSubjects.has(chip.dataset.val));
  });

  // 理解度スケール
  const comp = parseComprehension(log.comprehension);
  const compVal = comp ? String(comp) : '';
  const compEl = document.getElementById('f-comp');
  if (compEl) compEl.value = compVal;
  updateScaleUI(compVal);

  // 学習態度
  const attitudeEl = document.getElementById('f-attitude');
  if (attitudeEl) attitudeEl.value = log.attitude || '';

  // 講師メモ
  const notesEl = document.getElementById('f-notes');
  if (notesEl) notesEl.value = log.instructorNotes || '';

  // テスト・単元結果を復元（バグ修正①）
  // log.unit は保存時に buildFormData().scores として記録されたテキスト。
  // parseUnitToTestEntries でテストエントリー配列に変換してから renderTestList で描画する。
  renderTestList(parseUnitToTestEntries(log.unit));
  // 実施授業内容を復元
  const lessonContentEl = document.getElementById('f-lesson-content');
  if (lessonContentEl) lessonContentEl.value = log.lessonContent || '';
}

/** 履歴セクションに localStorage の過去データを描画する */
function renderHistoryView() {
  const historySec = document.getElementById('section-history');
  if (!historySec) return;

  const s    = students[currentIndex];
  const name = (s.data['f-name'] || '').trim();

  if (!name) {
    historySec.innerHTML = '<p class="history-empty">生徒名を入力すると履歴が表示されます。</p>';
    return;
  }

  const studentId = 'std_' + students[currentIndex].id;
  const pastData  = getStudentData(studentId);

  if (!pastData ||
      (pastData.lessonLogs.length === 0 && pastData.aiDiagnostics.length === 0)) {
    historySec.innerHTML = '<p class="history-empty">まだ履歴はありません。</p>';
    return;
  }

  let html = '';

  // ① 直近AI診断バッジ
  if (pastData.aiDiagnostics.length > 0) {
    const lastDiag = pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1];
    const prevDiag = pastData.aiDiagnostics.length > 1
      ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 2]
      : null;
    const { score, stars } = renderStars(lastDiag.overallScore);
    const pScore = prevDiag ? (Number(prevDiag.overallScore) || 0) : null;
    const diff   = pScore !== null ? score - pScore : null;

    html += `
      <div class="diag-badge-wrapper">
        <div class="diag-badge-label"><i class="ti ti-sparkles"></i> 直近のAI診断</div>
        <div class="diag-badge">
          <div class="diag-badge-score">
            <span class="diag-badge-stars">${stars}</span>
            <span class="diag-badge-num">${score}<small>/5</small></span>
            ${diff !== null
              ? `<span class="diag-badge-diff ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`
              : ''}
          </div>
          <div class="diag-badge-comment">${escapeHtml(lastDiag.overallComment || '')}</div>
          <div class="diag-badge-date">${escapeHtml(lastDiag.date || '')}</div>
        </div>
      </div>
    `;
  }

  // ② 理解度推移グラフ（Canvas）
  const logsWithComp = pastData.lessonLogs.filter(l =>
    parseComprehension(l.comprehension) > 0
  );
  if (logsWithComp.length > 0) {
    html += `
      <h3 class="history-section-title"><i class="ti ti-chart-line"></i> 理解度の推移</h3>
      <div class="chart-container">
        <canvas id="comp-chart"></canvas>
      </div>
    `;
  }

  // ③ 授業ログ（アコーディオン）
  if (pastData.lessonLogs.length > 0) {
    html += '<h3 class="history-section-title"><i class="ti ti-book"></i> 授業ログ</h3>';
    html += '<div class="accordion-list">';
    [...pastData.lessonLogs].reverse().forEach((log, idx) => {
      const comp  = parseComprehension(log.comprehension);
      const logId = escapeHtml(log.logId || '');
      html += `
        <div class="accordion-item${idx === 0 ? ' is-open' : ''}">
          <div class="accordion-header">
            <div class="accordion-header-left">
              <i class="ti ti-chevron-right accordion-icon"></i>
              <span class="history-date">${escapeHtml(log.date || '')}</span>
              ${log.subject ? `<span class="history-subject">${escapeHtml(log.subject)}</span>` : ''}
            </div>
            <div class="log-action-row">
              ${comp ? `<span class="history-comp">理解度 ${comp}/10</span>` : ''}
              <button type="button" class="log-action-btn edit-log-btn" data-logid="${logId}">
                <i class="ti ti-edit"></i> 編集
              </button>
              <button type="button" class="log-action-btn delete-btn delete-log-btn" data-logid="${logId}">
                <i class="ti ti-trash"></i> 削除
              </button>
            </div>
          </div>
          <div class="accordion-body">
            <div class="log-view">
              ${comp ? `
                <div class="accordion-comp-row">
                  <span class="mini-bar"><span class="mini-bar-fill" style="width:${Math.round(comp / 10 * 100)}%"></span></span>
                  <span class="accordion-comp-num">${comp} / 10</span>
                </div>` : ''}
              ${log.instructorNotes ? `<div class="accordion-field"><span class="accordion-field-label">講師メモ：</span>${escapeHtml(log.instructorNotes).replace(/\n/g, '<br>')}</div>` : ''}
              ${log.attitude        ? `<div class="accordion-field"><span class="accordion-field-label">学習態度：</span>${escapeHtml(log.attitude).replace(/\n/g, '<br>')}</div>` : ''}
              ${log.homeworkStatus  ? `<div class="accordion-field"><span class="accordion-field-label">宿題状況：</span>${escapeHtml(log.homeworkStatus).replace(/\n/g, '<br>')}</div>` : ''}
              ${log.unit            ? `<div class="accordion-field"><span class="accordion-field-label">単元/結果：</span>${escapeHtml(log.unit).replace(/\n/g, '<br>')}</div>` : ''}
            </div>

          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  // ④ AI診断履歴（アコーディオン）
  if (pastData.aiDiagnostics.length > 0) {
    html += '<h3 class="history-section-title"><i class="ti ti-sparkles"></i> AI診断履歴</h3>';
    html += '<div class="accordion-list">';
    [...pastData.aiDiagnostics].reverse().forEach((diag, idx) => {
      const { score, stars } = renderStars(diag.overallScore);
      html += `
        <div class="accordion-item${idx === 0 ? ' is-open' : ''}">
          <div class="accordion-header">
            <div class="accordion-header-left">
              <i class="ti ti-chevron-right accordion-icon"></i>
              <span class="history-date">${escapeHtml(diag.date || '')}</span>
              <span class="history-score">${stars}</span>
            </div>
            <span class="diag-score-badge">${score}/5</span>
          </div>
          <div class="accordion-body">
            <div class="accordion-field">${escapeHtml(diag.overallComment || '')}</div>
          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  historySec.innerHTML = html;

  // アコーディオン開閉（ログ操作ボタンのクリックは除外）
  historySec.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.log-action-btn')) return;
      header.closest('.accordion-item').classList.toggle('is-open');
    });
  });

  // ── 削除ボタン ──
  historySec.querySelectorAll('.delete-log-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const logId = btn.dataset.logid;
      if (!logId) return;
      if (confirm('この授業ログを削除しますか？')) {
        deleteLessonLog(studentId, logId);
        renderHistoryView();
      }
    });
  });
  // ── 編集ボタン ──
  historySec.querySelectorAll('.edit-log-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const logId = btn.dataset.logid;
      if (!logId) return;
      const log = pastData.lessonLogs.find(l => l.logId === logId);
      if (!log) return;

      // 編集対象ログIDを記憶し、授業記録タブへ遷移してからフォームへ値をセット
      // ※ switchMode を先に呼ぶことで saveCurrentForm() が実行される時点では
      //   DOM にはまだログ値が入っておらず、プロフィールデータの汚染を防ぐ（バグ④修正）
      _editingLogId = logId;
      _editingLog   = log;   // バグ②修正: unit引き継ぎ用にログオブジェクトを保持
      switchMode('report');
      loadLogIntoReportForm(log);
      showToast('授業記録を編集中です。');
    });
  });


  // Canvas グラフ描画
  if (logsWithComp.length > 0) {
    drawComprehensionChart(logsWithComp);
  }
}

/** 理解度の値を数値にパースする（"7 / 10" → 7 など） */
function parseComprehension(val) {
  if (val == null || val === '' || val === '未入力') return 0;
  if (typeof val === 'number') return val;
  const m = String(val).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Canvas に理解度推移グラフを描画する */
function drawComprehensionChart(logs) {
  const canvas = document.getElementById('comp-chart');
  if (!canvas || !canvas.getContext) return;

  // リサイズ再描画のためにログを保持
  _chartLogs = logs;

  const data = logs.slice(-10);

  const wrapper = canvas.parentElement;
  const W = Math.max(wrapper.clientWidth || 320, 200);
  const H = 160;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.width  = '100%';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  const PAD = { top: 20, right: 20, bottom: 38, left: 36 };
  const cW  = W - PAD.left - PAD.right;
  const cH  = H - PAD.top  - PAD.bottom;

  const primary = '#4f46e5';
  const muted   = '#9ca3af';
  const border  = '#e5e7eb';

  ctx.clearRect(0, 0, W, H);

  function getX(i) {
    return PAD.left + (data.length > 1 ? (i / (data.length - 1)) * cW : cW / 2);
  }
  function getY(v) {
    return PAD.top + cH - (v / 10) * cH;
  }

  // グリッド線と Y ラベル
  [2, 4, 6, 8, 10].forEach(v => {
    const y = getY(v);
    ctx.beginPath();
    ctx.strokeStyle = border;
    ctx.lineWidth   = 1;
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    ctx.fillStyle    = muted;
    ctx.font         = '10px system-ui,sans-serif';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), PAD.left - 5, y);
  });

  // グラデーション塗りつぶし
  if (data.length > 1) {
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, 'rgba(79,70,229,0.22)');
    grad.addColorStop(1, 'rgba(79,70,229,0)');
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(parseComprehension(data[0].comprehension)));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(getX(i), getY(parseComprehension(data[i].comprehension)));
    }
    ctx.lineTo(getX(data.length - 1), PAD.top + cH);
    ctx.lineTo(getX(0), PAD.top + cH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // 折れ線
  if (data.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = primary;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.moveTo(getX(0), getY(parseComprehension(data[0].comprehension)));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(getX(i), getY(parseComprehension(data[i].comprehension)));
    }
    ctx.stroke();
  }

  // ドット・値ラベル・日付ラベル
  data.forEach((log, i) => {
    const x   = getX(i);
    const val = parseComprehension(log.comprehension);
    const y   = getY(val);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle   = '#fff';
    ctx.strokeStyle = primary;
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle    = primary;
    ctx.font         = 'bold 10px system-ui,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(val), x, y - 6);

    const dateLabel = (log.date || '').replace(/^\d{4}-/, '').replace('-', '/');
    ctx.fillStyle    = muted;
    ctx.font         = '9px system-ui,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(dateLabel, x, H - PAD.bottom + 6);
  });
}

/* ===========================
   フォーム保存・復元
=========================== */
function saveCurrentForm() {
  const s = students[currentIndex];
  FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) s.data[id] = el.value;
  });
  s.data.subjects       = [...selectedSubjects];
  s.data.tests          = collectTestEntries();
  s.data.shortTermGoals = collectGoalEntries();
  saveStudentsTabs(); // フォーム内容の変更を即時永続化
}

function restoreForm(s) {
  FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = s.data[id] || '';
  });

  // 授業日フィールドが未入力の場合のみ、今日の日付を自動セット
  const lessonDateEl = document.getElementById('lesson-date');
  if (lessonDateEl && !s.data['lesson-date']) {
    lessonDateEl.value = getLocalDate();
  }

  updateScaleUI(s.data['f-comp'] || '');

  selectedSubjects.clear();
  (s.data.subjects || []).forEach(v => selectedSubjects.add(v));
  document.querySelectorAll('#subjects .chip').forEach(chip => {
    chip.classList.toggle('selected', selectedSubjects.has(chip.dataset.val));
  });

  const tests = (s.data.tests && s.data.tests.length > 0)
    ? s.data.tests
    : [createTestEntry()];
  renderTestList(tests);

  const goals = (s.data.shortTermGoals?.length > 0)
    ? s.data.shortTermGoals
    : [createShortTermGoalEntry()];
  renderGoalList(goals);

  // モード自動判別（生徒タブ初回表示時のみ実行）
  if (!s.modeInitialized) {
    s.mode = detectMode('std_' + s.id);
    s.modeInitialized = true;
  }

  updateSubNavActive(s.mode);
  showModeSection(s.mode);

  // 基本情報フィールドのロック状態を更新
  updateBasicInfoLock(s);

  if (s.lastResultType === 'lessonplan' && s.lessonPlanResult) {
    renderLessonPlanResult(s.lessonPlanResult, buildFormData());
    showState('state-result');
  } else if (s.result) {
    s.lastResultType = 'diagnosis';
    renderResult(s.result, buildFormData());
    showState('state-result');
  } else {
    showState('state-empty');
  }
}

/* ===========================
   タブ描画・操作・ユーティリティ等は変更なし
=========================== */
function renderTabs() {
  const list = document.getElementById('tab-list');
  list.innerHTML = '';
  students.forEach((s, i) => {
    const tab = document.createElement('button');
    tab.className = 'tab-item' + (i === currentIndex ? ' active' : '');
    tab.setAttribute('data-idx', i);
    tab.type = 'button';
    tab.innerHTML = `
      <i class="ti ti-user-circle"></i>
      <span class="tab-label">${escapeHtml(s.tabName)}</span>
      ${students.length > 1
        ? `<span class="tab-close" data-idx="${i}" title="削除"><i class="ti ti-x"></i></span>`
        : ''}
    `;
    tab.addEventListener('click', e => {
      if (e.target.closest('.tab-close')) return;
      switchTab(i);
    });
    const closeBtn = tab.querySelector('.tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        const name = students[i].data?.['f-name']?.trim() || students[i].tabName;
        if (!confirm(`「${name}」のデータを削除しますか？\nこの操作は元に戻せません。`)) return;
        removeStudent(i);
      });
    }
    list.appendChild(tab);
  });
  const activeTab = list.querySelector('.tab-item.active');
  if (activeTab) {
    activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

function switchTab(idx) {
  saveCurrentForm();
  currentIndex = idx;
  saveStudentsTabs(); // currentIndex の変更を永続化
  renderTabs();
  restoreForm(students[currentIndex]);
}

function addStudent() {
  saveCurrentForm();
  students.push(createStudent());
  currentIndex = students.length - 1;
  saveStudentsTabs(); // 新規タブを永続化（saveCurrentForm()はpush前に呼ばれているため別途保存）
  renderTabs();
  restoreForm(students[currentIndex]);
  const list = document.getElementById('tab-list');
  setTimeout(() => { list.scrollLeft = list.scrollWidth; }, 50);
}

function removeStudent(idx) {
  if (students.length === 1) return;
  saveCurrentForm();
  const removedKey = `student_data_std_${students[idx].id}`;
  localStorage.removeItem(removedKey);
  students.splice(idx, 1);
  // 残存する最大番号+1 に studentCounter をリセット
  resetStudentCounter();
  if (idx < currentIndex || currentIndex >= students.length) {
    currentIndex = Math.max(0, currentIndex - 1);
  }
  saveStudentsTabs(); // タブ削除後の状態を永続化（splice後に呼ぶ必要がある）
  renderTabs();
  restoreForm(students[currentIndex]);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showInlineError(message) {
  const errEl = document.getElementById('state-error');
  errEl.innerHTML = `
    <div class="error-box">
      <i class="ti ti-alert-triangle"></i>
      <span>${message}</span>
    </div>
  `;
  showState('state-error');
}

function showApiKeyError() {
  showInlineError(
    'APIキーを入力してください。<br>' +
    '<small><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;">Google AI Studio で無料取得できます →</a></small>'
  );
}

function updateScaleUI(val) {
  document.querySelectorAll('#comp-scale .scale-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === String(val));
  });
}


const selectedSubjects = new Set();


function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function buildFormData() {
  const compVal = getVal('f-comp');

  const tests       = collectTestEntries();
  const filledTests = tests.filter(t => t.scores || t.type);
  let scoresText    = '未入力';

  if (filledTests.length > 0) {
    scoresText = filledTests.map((t, i) => {
      const parts  = [];
      if (t.type) parts.push(t.type);
      if (t.grade) parts.push(`対象: ${t.grade}`);
      if (t.date) parts.push(`実施日: ${t.date}`);
      const label  = parts.length > 0 ? `[${parts.join(' / ')}]` : `[テスト${i + 1}]`;
      return t.scores ? `${label}\n${t.scores}` : label;
    }).join('\n\n');
  }

  const filledGoals = collectGoalEntries().filter(g => g.text);
  const shortTermGoalsText = filledGoals.length > 0
    ? filledGoals.map((g, i) => {
        const dl = g.deadline ? `（期限: ${g.deadline}）` : '';
        return `${i + 1}. ${g.text}${dl}`;
      }).join('\n')
    : '未設定';

  return {
    name:           getVal('f-name')     || '未入力',
    grade:          getVal('f-grade')    || '未入力',
    subjects:       [...selectedSubjects].join('、') || '未入力',
    scores:         scoresText,
    comp:           compVal ? `${compVal} / 10` : '未入力',
    attitude:       getVal('f-attitude') || '未入力',
    goal:           getVal('f-goal')     || '未入力',
    shortTermGoals: shortTermGoalsText,
    concerns:       getVal('f-concerns') || '未入力',
    notes:          getVal('f-notes')    || '未入力',
    lessonContent:  getVal('f-lesson-content') || '未入力',
  };
}

// buildFormData() の直後に追加
function resetLessonContentField() {
  const el = document.getElementById('f-lesson-content');
  if (el) el.value = '';
}

function showState(id) {
  ['state-empty', 'state-loading', 'state-error', 'state-result', 'state-summary'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = (s === id) ? '' : 'none';
  });
}

/** ローディング画面のテキストを動的に差し替える */
function setLoadingText(title, sub) {
  const titleEl = document.querySelector('#state-loading .state-title');
  const subEl   = document.querySelector('#state-loading .state-sub');
  if (titleEl) titleEl.textContent = title;
  if (subEl)   subEl.textContent   = sub || 'しばらくお待ちください';
}

/* ===========================
   テストエントリー管理
=========================== */

function renderTestList(tests) {
  const list = document.getElementById('test-list');
  list.innerHTML = '';
  tests.forEach((t, i) => {
    const el = createTestEntryElement(t, i);
    if (i !== tests.length - 1) {
      el.classList.remove('is-open');
    }
    list.appendChild(el);
  });
}

/** 1件のテストエントリー要素を生成してイベントをバインドする */
function createTestEntryElement(test, idx) {
  const div      = document.createElement('div');
  div.className  = 'test-entry is-open';

  div.innerHTML = `
    <div class="test-entry-header" title="クリックで開閉">
      <div class="test-header-left">
        <i class="ti ti-chevron-down test-toggle-icon"></i>
        <span class="test-entry-num">テスト ${idx + 1}</span>
        <span class="test-preview"></span>
      </div>
      <button class="test-remove-btn" type="button" title="このテストを削除">
        <i class="ti ti-trash"></i>
      </button>
    </div>

    <div class="test-entry-content">
      <div class="test-field">
        <label class="test-field-label">試験の種類</label>
        <input type="text" class="test-type-input" placeholder="例：全統記述模試、定期テスト" value="${escapeHtml(test.type || '')}" list="test-type-list-${idx}">
        <datalist id="test-type-list-${idx}">
          ${TEST_TYPE_SUGGESTIONS.map(t => `<option value="${escapeHtml(t)}"></option>`).join('')}
        </datalist>
      </div>

      <div class="test-field">
        <label class="test-field-label">模試対応学年</label>
        <select class="test-grade-select">
          <option value="">選択しない</option>
          ${['小1','小2','小3','小4','小5','小6','中1','中2','中3','高1','高2','高3','高卒・浪人'].map(g => 
            `<option value="${g}" ${g === test.grade ? 'selected' : ''}>${g}</option>`
          ).join('')}
        </select>
      </div>

      <div class="test-field">
        <label class="test-field-label">実施日</label>
        <input type="date" class="test-date-input" value="${escapeHtml(test.date || '')}">
      </div>

      <div class="test-field">
        <label class="test-field-label">点数・結果</label>
        <textarea class="test-scores" placeholder="例：数学 75点、偏差値 55.2">${escapeHtml(test.scores || '')}</textarea>
      </div>
    </div>
  `;

  // ── プレビューの更新処理 ──
  const previewSpan = div.querySelector('.test-preview');
  function updatePreview() {
    const type = div.querySelector('.test-type-input').value.trim();
    const scores = div.querySelector('.test-scores').value.trim();
    let previewText = '';
    if (type) previewText += type;
    if (scores) previewText += (previewText ? ' - ' : '') + scores.replace(/\n/g, ' ');
    previewSpan.textContent = previewText || '(未入力)';
  }

  div.querySelectorAll('.test-type-input, .test-scores').forEach(el => {
    el.addEventListener('input', updatePreview);
  });
  updatePreview();

  // ── 開閉処理 ──
  const header = div.querySelector('.test-entry-header');
  header.addEventListener('click', (e) => {
    if (e.target.closest('.test-remove-btn')) return;
    div.classList.toggle('is-open');
  });

  // ── 削除ボタン ──
  div.querySelector('.test-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const list = document.getElementById('test-list');
    div.remove();
    renumberTestEntries();
    if (!list.querySelector('.test-entry')) {
      list.appendChild(createTestEntryElement(createTestEntry(), 0));
    }
  });

  return div;
}

/** DOM からテストエントリーデータを収集する */
function collectTestEntries() {
  const entries = [];
  document.querySelectorAll('#test-list .test-entry').forEach(entryEl => {
    const type   = entryEl.querySelector('.test-type-input')?.value.trim() || '';
    const grade  = entryEl.querySelector('.test-grade-select')?.value || '';
    const date   = entryEl.querySelector('.test-date-input')?.value || '';
    const scores = entryEl.querySelector('.test-scores')?.value.trim() || '';
    entries.push({ type, grade, date, scores });
  });
  return entries;
}

function renumberTestEntries() {
  document.querySelectorAll('#test-list .test-entry').forEach((el, i) => {
    const numEl = el.querySelector('.test-entry-num');
    if (numEl) numEl.textContent = `テスト ${i + 1}`;

    const input = el.querySelector('.test-type-input');
    const datalist = el.querySelector('datalist');
    if (input && datalist) {
      const listId = `test-type-list-${i}`;
      input.setAttribute('list', listId);
      datalist.id = listId;
    }
  });
}



/* ===========================
   短期目標エントリー
=========================== */

/** #short-goal-list の中身をまとめて再描画する */
function renderGoalList(goals) {
  const list = document.getElementById('short-goal-list');
  list.innerHTML = '';
  goals.forEach((g, i) => {
    list.appendChild(createGoalEntryElement(g, i));
  });
}

/** 1件の短期目標エントリー要素を生成してイベントをバインドする */
function createGoalEntryElement(g, idx) {
  const div     = document.createElement('div');
  div.className = 'goal-entry';

  div.innerHTML = `
    <span class="goal-entry-num">${idx + 1}</span>
    <input
      type="text"
      class="goal-text-input"
      placeholder="例：連立方程式を解けるようにする"
      value="${escapeHtml(g.text || '')}"
    >
    <input
      type="date"
      class="goal-deadline-input"
      value="${escapeHtml(g.deadline || '')}"
      title="達成期限"
    >
    <button class="goal-remove-btn" type="button" title="この目標を削除">
      <i class="ti ti-trash"></i>
    </button>
  `;

  // ── 削除ボタン ──
  div.querySelector('.goal-remove-btn').addEventListener('click', () => {
    const list = document.getElementById('short-goal-list');
    div.remove();
    renumberGoalEntries();
    if (!list.querySelector('.goal-entry')) {
      list.appendChild(createGoalEntryElement(createShortTermGoalEntry(), 0));
    }
  });

  return div;
}

/** DOM から短期目標エントリーデータを収集する */
function collectGoalEntries() {
  const entries = [];
  document.querySelectorAll('#short-goal-list .goal-entry').forEach(entryEl => {
    const text     = entryEl.querySelector('.goal-text-input')?.value.trim()     || '';
    const deadline = entryEl.querySelector('.goal-deadline-input')?.value        || '';
    entries.push({ text, deadline });
  });
  return entries;
}

function renumberGoalEntries() {
  document.querySelectorAll('#short-goal-list .goal-entry').forEach((el, i) => {
    const numEl = el.querySelector('.goal-entry-num');
    if (numEl) numEl.textContent = i + 1;
  });
}






/* ===========================
   次回授業案をHTMLに描画する
=========================== */
function renderLessonPlanResult(d, formData) {
  const subLine = [formData.grade, formData.subjects]
    .filter(v => v !== '未入力').join(' ／ ');

  const keyPointsHTML = (d.keyPoints || []).map(p => `<li>${escapeHtml(p)}</li>`).join('');
  const pitfallsHTML  = (d.pitfalls  || []).map(p => `<li>${escapeHtml(p)}</li>`).join('');

  const html = `
    <!-- アクションバー -->
    <div class="result-actions no-print">
      <button type="button" class="action-btn action-btn-teal" id="lesson-copy-btn">
        <i class="ti ti-copy"></i> 授業案をコピー
      </button>
      ${students[currentIndex]?.result ? `
      <button type="button" class="action-btn action-btn-primary" id="switch-to-diagnosis-btn">
        <i class="ti ti-report-analytics"></i> 診断レポートを表示
      </button>` : ''}
    </div>

    <!-- ヘッダー：授業目標 -->
    <div class="result-card card-lesson">
      <div class="hero-row">
        <div>
          <div class="hero-name" style="color:#0f766e">${escapeHtml(formData.name)} さん — 次回授業案</div>
          <div class="hero-sub" style="color:#14b8a6">${escapeHtml(subLine)}</div>
        </div>
        <i class="ti ti-calendar-event" style="font-size:30px;color:#14b8a6;opacity:0.55;flex-shrink:0"></i>
      </div>
      <div class="card-body" style="color:#134e4a;font-weight:600">${escapeHtml(d.objective || '')}</div>
    </div>

    <!-- 重点指導ポイント -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-target"></i> 重点指導ポイント</div>
      <ul class="diag-list">${keyPointsHTML}</ul>
    </div>

    <!-- 教材・準備物 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-books"></i> 教材・準備物</div>
      <div class="card-body">${escapeHtml(d.materials || '')}</div>
    </div>

    <!-- つまずきポイントと対処法 -->
    <div class="result-card card-improvements">
      <div class="card-label"><i class="ti ti-alert-triangle"></i> つまずきやすい箇所と対処法</div>
      <ul class="diag-list">${pitfallsHTML}</ul>
    </div>

    <!-- 宿題・自習課題 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-home"></i> 宿題・自習課題</div>
      <div class="card-body">${escapeHtml(d.homework || '')}</div>
    </div>

    <!-- 指導のヒント -->
    <div class="result-card card-lesson">
      <div class="card-label"><i class="ti ti-bulb"></i> 指導のヒント</div>
      <div class="card-body">${escapeHtml(d.teachingTips || '')}</div>
    </div>
  `;

  document.getElementById('state-result').innerHTML = html;

  // 授業案コピーボタン
  document.getElementById('lesson-copy-btn').addEventListener('click', () => {
    const fullText = `
【次回授業案】${formData.name} さん（${subLine}）

■ 授業目標
${d.objective || ''}

■ 重点指導ポイント
${(d.keyPoints || []).map(p => `・${p}`).join('\n')}

■ 教材・準備物
${d.materials || ''}

■ つまずきやすい箇所と対処法
${(d.pitfalls || []).map(p => `・${p}`).join('\n')}

■ 宿題・自習課題
${d.homework || ''}

■ 指導のヒント
${d.teachingTips || ''}
`.trim();

    copyToClipboard(fullText, 'lesson-copy-btn', '<i class="ti ti-copy"></i> 授業案をコピー');
  });

  // 診断レポートに切り替えるボタン（診断結果が存在する場合のみ表示）
  const switchBtn = document.getElementById('switch-to-diagnosis-btn');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => {
      const s = students[currentIndex];
      if (s.result) {
        s.lastResultType = 'diagnosis';
        renderResult(s.result, buildFormData());
        showState('state-result');
      }
    });
  }
}


/* ===========================
   診断結果をHTMLに描画する・初期化
=========================== */
function renderResult(d, formData) {
  const { score: clampedScore, stars } = renderStars(d.overallScore);
  const subLine = [formData.grade, formData.subjects]
    .filter(v => v !== '未入力').join(' ／ ');

  const strengthsHTML    = (d.strengths    || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
  const improvementsHTML = (d.improvements || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');

  const html = `
    <!-- 印刷・共有用アクションバー（画面表示時のみ） -->
    <div class="result-actions no-print">
      <button type="button" class="action-btn action-btn-primary" id="print-btn">
        <i class="ti ti-printer"></i> 印刷 / PDF保存
      </button>
      <button type="button" class="action-btn" id="copy-all-btn">
        <i class="ti ti-copy"></i> レポート全体をコピー
      </button>
      ${students[currentIndex]?.lessonPlanResult ? `
      <button type="button" class="action-btn action-btn-teal-outline" id="switch-to-lesson-btn">
        <i class="ti ti-calendar-event"></i> 授業案を表示
      </button>` : ''}
    </div>

    <!-- 総合評価 -->
    <div class="result-card card-hero">
      <div class="hero-row">
        <div>
          <div class="hero-name">${escapeHtml(formData.name)} さん — AI診断レポート</div>
          <div class="hero-sub">${escapeHtml(subLine)}</div>
        </div>
        <div>
          <div class="score-stars">${stars}</div>
          <div class="score-label">総合評価 ${clampedScore} / 5</div>
        </div>
      </div>
      <div class="card-body">${escapeHtml(d.overallComment || '')}</div>
    </div>

    <!-- 今すぐ取り組むべきこと -->
    <div class="result-card card-urgent">
      <div class="card-label">
        <i class="ti ti-alert-circle"></i> 今すぐ取り組むべきこと
      </div>
      <div class="card-body">${escapeHtml(d.urgentAction || '')}</div>
    </div>

    <!-- 強み・改善点 -->
    <div class="two-col">
      <div class="result-card card-strengths">
        <div class="card-label"><i class="ti ti-thumb-up"></i> 強み</div>
        <ul class="diag-list">${strengthsHTML}</ul>
      </div>
      <div class="result-card card-improvements">
        <div class="card-label"><i class="ti ti-trending-up"></i> 改善点</div>
        <ul class="diag-list">${improvementsHTML}</ul>
      </div>
    </div>

    <!-- 次回授業プラン -->
    ${d.nextLessonPlan ? `
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-event"></i> 次回授業プラン</div>
      <div class="card-body">
        <div style="font-weight:600;margin-bottom:8px">${escapeHtml(d.nextLessonPlan.objective || '')}</div>
        ${(d.nextLessonPlan.keyPoints || []).length > 0 ? `
          <div style="margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:4px">重点ポイント</div>
            <ul class="diag-list">${(d.nextLessonPlan.keyPoints || []).map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
          </div>` : ''}
        ${d.nextLessonPlan.materials ? `
          <div style="margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:2px">教材・準備物</div>
            <div>${escapeHtml(d.nextLessonPlan.materials)}</div>
          </div>` : ''}
        ${(d.nextLessonPlan.pitfalls || []).length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:4px">注意点・つまずきやすい箇所</div>
            <ul class="diag-list">${(d.nextLessonPlan.pitfalls || []).map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
          </div>` : ''}
      </div>
    </div>` : ''}

    <!-- 1週間の学習プラン -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-week"></i> 1週間の推奨学習プラン</div>
      <div class="card-body">${escapeHtml(d.weeklyPlan || '')}</div>
    </div>

    <!-- 1ヶ月の目標 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-month"></i> 1ヶ月の目標と方針</div>
      <div class="card-body">${escapeHtml(d.monthlyPlan || '')}</div>
    </div>

    <!-- 講師アドバイス -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-bulb"></i> 講師へのアドバイス</div>
      <div class="card-body">${escapeHtml(d.instructorAdvice || '')}</div>
    </div>

    <!-- 保護者向けコメント -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-mail"></i> 保護者向けコメント文案</div>
      <div class="parent-block" id="parent-text">${escapeHtml(d.parentMessage || '')}</div>
      <button type="button" class="copy-btn no-print" id="copy-btn">
        <i class="ti ti-copy"></i> 保護者コメントのみコピー
      </button>
    </div>
  `;

  document.getElementById('state-result').innerHTML = html;

  // --- イベントバインド ---

  // 1. 印刷 / PDF保存ボタン
  document.getElementById('print-btn').addEventListener('click', () => {
    window.print();
  });

  // 2. レポート全体テキストコピー
  document.getElementById('copy-all-btn').addEventListener('click', () => {
    const fullText = `
【生徒診断レポート】${formData.name} さん（${subLine}）
総合評価: ${d.overallScore}/5

■ 総合評価・診断コメント
${d.overallComment || ''}

■ 今すぐ取り組むべきこと
${d.urgentAction || ''}

■ 強み
${(d.strengths || []).map(s => `・${s}`).join('\n')}

■ 改善点
${(d.improvements || []).map(s => `・${s}`).join('\n')}

■ 1週間の推奨学習プラン
${d.weeklyPlan || ''}

■ 1ヶ月の目標と方針
${d.monthlyPlan || ''}

■ 次回授業プラン
${d.nextLessonPlan ? `目標: ${d.nextLessonPlan.objective || ''}
重点ポイント:
${(d.nextLessonPlan.keyPoints || []).map(p => `・${p}`).join('\n')}
教材・準備物: ${d.nextLessonPlan.materials || ''}
注意点:
${(d.nextLessonPlan.pitfalls || []).map(p => `・${p}`).join('\n')}` : '（なし）'}

■ 講師へのアドバイス
${d.instructorAdvice || ''}

■ 保護者向けコメント
${d.parentMessage || ''}
`.trim();

    copyToClipboard(fullText, 'copy-all-btn', '<i class="ti ti-copy"></i> レポート全体をコピー');
  });

  // 3. 保護者用コメントコピーボタン
  document.getElementById('copy-btn').addEventListener('click', () => {
    const text = document.getElementById('parent-text').innerText;
    copyToClipboard(text, 'copy-btn', '<i class="ti ti-copy"></i> 保護者コメントのみコピー');
  });

  // 4. 次回授業案に切り替えるボタン（授業案が存在する場合のみ表示）
  const switchToLessonBtn = document.getElementById('switch-to-lesson-btn');
  if (switchToLessonBtn) {
    switchToLessonBtn.addEventListener('click', () => {
      const s = students[currentIndex];
      if (s.lessonPlanResult) {
        s.lastResultType = 'lessonplan';
        renderLessonPlanResult(s.lessonPlanResult, buildFormData());
        showState('state-result');
      }
    });
  }
}


/* ===========================
   Step 6: データ管理
=========================== */

/** 全生徒データをJSONファイルとしてダウンロード */
function exportAllData() {
  saveCurrentForm();

  const exportObj = {
    exportedAt:     new Date().toISOString(),
    appVersion:     'step6',
    tabs:           students.map(s => ({
      id:          s.id,
      tabName:     s.tabName,
      defaultName: s.defaultName,
      data:        s.data,
    })),
    studentRecords: {}
  };

  students.forEach(s => {
    const sid    = 'std_' + s.id;
    const record = getStudentData(sid);
    if (record) exportObj.studentRecords[sid] = record;
  });

  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `生徒データ_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  showToast('エクスポートが完了しました ✓');
}

/** JSONファイルを読み込んでデータを復元する */
function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);

      // ① localStorageへ生徒記録を保存
      if (parsed.studentRecords && typeof parsed.studentRecords === 'object') {
        Object.entries(parsed.studentRecords).forEach(([sid, record]) => {
          saveStudentData({ ...record, studentId: sid });
        });
      }

      // ② タブ一覧も上書きするか確認
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        if (confirm('タブ（生徒一覧）も上書きしますか？\nキャンセルすると学習記録のみ復元されます。')) {
          students = parsed.tabs.map(t => ({
            ...createStudent(),
            id:               t.id           || Date.now() + Math.random(),
            tabName:          t.tabName      || t.defaultName || '生徒',
            defaultName:      t.defaultName  || '生徒',
            data:             t.data         || {},
            result:           null,
            lessonPlanResult: null,
            lastResultType:   'diagnosis',
            mode:             'profile',
            modeInitialized:  false,
          }));
          // ③ studentCounter リセット（initStudents と同じロジック）
          // createStudent() の呼び出し回数分だけ余計に加算されたカウンタを
          // インポートデータの最大番号 + 1 に揃え直す
          resetStudentCounter();
          currentIndex = 0;
          saveStudentsTabs(); // インポートしたタブ一覧を永続化
          renderTabs();
          restoreForm(students[currentIndex]);
        }
      }

      showToast('インポートが完了しました ✓');
    } catch (err) {
      showToast('インポートに失敗: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

/** 一時トースト通知を表示する */
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `data-toast data-toast-${type}`;
  const icon = type === 'success' ? 'ti-circle-check' : 'ti-alert-triangle';
  toast.innerHTML = `<i class="ti ${icon}"></i> ${escapeHtml(message)}`;
  document.body.appendChild(toast);
  // ダブル rAF で transition を確実に発火させる
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/** 右パネルに全生徒の横断サマリーを描画する */
function renderSummaryPanel() {
  saveCurrentForm();

  const TODAY      = new Date();
  const DANGER_COMP  = 4;   // 理解度 ≤ この値でフラグ（赤）
  const ABSENT_DAYS  = 14;  // この日数以上授業なしでフラグ（黄）

  /* ---- 各生徒のデータを集計 ---- */
  const rows = students.map((s, idx) => {
    const name  = (s.data['f-name'] || '').trim() || s.defaultName;
    const grade = s.data['f-grade'] || '—';

    const record  = getStudentData('std_' + s.id);
    const logs    = record ? record.lessonLogs : [];

    // 直近理解度（記録があるログの最新値）
    const logsWithComp = logs.filter(l => parseComprehension(l.comprehension) > 0);
    const lastComp = logsWithComp.length > 0
      ? parseComprehension(logsWithComp[logsWithComp.length - 1].comprehension)
      : null;

    // 最終授業日
    const lastLog  = logs.length > 0 ? logs[logs.length - 1] : null;
    const lastDate = lastLog ? lastLog.date : null;
    const daysAgo  = lastDate
      ? Math.floor((TODAY - new Date(lastDate + 'T00:00:00')) / 86400000)
      : null;

    // フラグ判定
    const flags = [];
    if (lastComp !== null && lastComp <= DANGER_COMP) {
      flags.push({ type: 'danger',  icon: 'ti-alert-circle', label: `理解度 ${lastComp}/10` });
    }
    if (daysAgo !== null && daysAgo >= ABSENT_DAYS) {
      flags.push({ type: 'warning', icon: 'ti-clock',        label: `${daysAgo}日授業なし` });
    }
    if (flags.length === 0 && lastDate === null) {
      flags.push({ type: 'muted',   icon: 'ti-pencil-off',   label: '授業記録なし' });
    }

    return { idx, name, grade, lastDate, daysAgo, lastComp, flags };
  });

  /* ---- KPI 集計 ---- */
  const dangerCount  = rows.filter(r => r.flags.some(f => f.type === 'danger')).length;
  const warningCount = rows.filter(r => r.flags.some(f => f.type === 'warning')).length;

  /* ---- HTML 組み立て ---- */
  let html = `
    <div class="summary-header">
      <div class="summary-title"><i class="ti ti-users"></i> 全生徒サマリー</div>
      <div class="summary-meta">${students.length} 名登録中</div>
    </div>

    <div class="summary-kpi-row">
      <div class="summary-kpi ${dangerCount  > 0 ? 'kpi-danger'  : 'kpi-ok'}">
        <div class="kpi-num">${dangerCount}</div>
        <div class="kpi-label">理解度が低い生徒</div>
      </div>
      <div class="summary-kpi ${warningCount > 0 ? 'kpi-warning' : 'kpi-ok'}">
        <div class="kpi-num">${warningCount}</div>
        <div class="kpi-label">2週間以上授業なし</div>
      </div>
      <div class="summary-kpi kpi-neutral">
        <div class="kpi-num">${students.length}</div>
        <div class="kpi-label">総生徒数</div>
      </div>
    </div>

    <div class="summary-table-wrap">
      <table class="summary-table">
        <thead>
          <tr>
            <th>生徒名</th>
            <th>学年</th>
            <th>直近理解度</th>
            <th>最終授業日</th>
            <th>ステータス</th>
          </tr>
        </thead>
        <tbody>
  `;

  rows.forEach(r => {
    const hasDanger  = r.flags.some(f => f.type === 'danger');
    const hasWarning = r.flags.some(f => f.type === 'warning');
    const rowClass   = hasDanger ? 'row-danger' : hasWarning ? 'row-warning' : '';

    const flagsHTML = r.flags.map(f =>
      `<span class="flag-badge flag-${f.type}"><i class="ti ${f.icon}"></i> ${escapeHtml(f.label)}</span>`
    ).join('');

    const compCell = r.lastComp !== null
      ? `<div class="comp-mini">
           <span class="mini-bar"><span class="mini-bar-fill" style="width:${Math.round(r.lastComp / 10 * 100)}%"></span></span>
           <span>${r.lastComp}/10</span>
         </div>`
      : '<span class="summary-text-muted">—</span>';

    const dateCell = r.lastDate
      ? `${escapeHtml(r.lastDate)}<br><span class="summary-text-muted" style="font-size:10px">${r.daysAgo}日前</span>`
      : '<span class="summary-text-muted">記録なし</span>';

    html += `
      <tr class="${rowClass}" data-student-idx="${r.idx}" title="${escapeHtml(r.name)} のタブへ移動">
        <td><span class="student-name-cell"><i class="ti ti-user-circle"></i> ${escapeHtml(r.name)}</span></td>
        <td>${escapeHtml(r.grade)}</td>
        <td>${compCell}</td>
        <td>${dateCell}</td>
        <td>${flagsHTML}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>

    <div class="summary-actions">
      <button type="button" class="action-btn action-btn-primary" id="summary-export-btn">
        <i class="ti ti-download"></i> 全データをエクスポート
      </button>
      <label class="action-btn summary-import-label">
        <i class="ti ti-upload"></i> データをインポート
        <input type="file" id="summary-import-input" accept=".json" style="display:none">
      </label>
    </div>
    <p class="summary-hint">
      <i class="ti ti-info-circle"></i>
      生徒の行をクリックするとそのタブへ切り替わります
    </p>
  `;

  const summaryEl = document.getElementById('state-summary');
  summaryEl.innerHTML = html;
  showState('state-summary');

  // 行クリック → 該当タブへ切替
  summaryEl.querySelectorAll('tr[data-student-idx]').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => switchTab(Number(row.dataset.studentIdx)));
  });

  // サマリー内エクスポートボタン
  document.getElementById('summary-export-btn').addEventListener('click', exportAllData);

  // サマリー内インポートボタン
  const summaryImportInput = document.getElementById('summary-import-input');
  summaryImportInput.addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
}

/* ===========================
   授業記録のみを保存する（新規追加）
=========================== */
function updateEditModeUI() {
  const isEditing = !!_editingLogId;
  const genBtn    = document.getElementById('gen-btn');
  const nextBtn   = document.getElementById('next-lesson-btn');
  const saveBtn   = document.getElementById('save-log-btn');   // ← 追加
  const cancelBtn = document.getElementById('cancel-edit-btn');
  if (genBtn)    genBtn.style.display    = isEditing ? 'none' : '';
  if (nextBtn)   nextBtn.style.display   = isEditing ? 'none' : '';
  if (cancelBtn) cancelBtn.style.display = isEditing ? ''     : 'none';
  // ↓ 追加：編集モードに応じてラベルとスタイルクラスを切り替える
  if (saveBtn) {
    saveBtn.innerHTML = isEditing
      ? '<i class="ti ti-device-floppy"></i> 編集内容を保存'
      : '<i class="ti ti-save"></i> 授業記録のみ保存する';
    saveBtn.classList.toggle('save-log-btn--editing', isEditing);
  }
}

function cancelEditMode() {
  _editingLogId = null;
  _editingLog   = null;
  // フォームを編集開始前の状態（student.data）に復元
  restoreForm(students[currentIndex]);
  // 履歴タブへ直接遷移（saveCurrentForm をスキップ）
  students[currentIndex].mode = 'history';
  saveStudentsTabs();
  updateSubNavActive('history');
  showModeSection('history');
  updateEditModeUI();
  showToast('編集をキャンセルしました');
}

function injectSaveLogButton() {
  // HTML に既存のボタンがあればそのまま使い、なければ動的生成して gen-btn の直後に挿入
  let btn = document.getElementById('save-log-btn');
  let cancelBtn = document.getElementById('cancel-edit-btn');

  if (!btn) {
    const genBtn = document.getElementById('gen-btn');
    if (!genBtn) return;

    btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'action-btn';
    btn.id        = 'save-log-btn';
    btn.innerHTML = '<i class="ti ti-save"></i> 授業記録のみ保存する';

    // gen-btn の直後に挿入
    genBtn.insertAdjacentElement('afterend', btn);
  }

  // ── HTML既存ボタン・動的生成ボタンどちらにも必ず onclick を設定する ──
  btn.onclick = () => {
    const formData   = buildFormData();
    const lessonDate = getVal('lesson-date') || getLocalDate();

    if (!formData.name || formData.name === '未入力') {
      showToast('生徒名を入力してください', 'error');
      return;
    }

    const studentId  = 'std_' + students[currentIndex].id;
    const wasEditing = !!_editingLogId; // 保存前に編集モードを記憶

    const action = saveOrUpdateLessonLog(studentId, formData, lessonDate);
    showToast(action === 'updated' ? '授業記録を更新しました ✓' : '授業記録を保存しました ✓');
    resetLessonContentField();   // switchMode/restoreForm の前に実行

    if (wasEditing) {
      // 編集時: saveCurrentForm() をスキップして s.data を汚染しない
      // saveOrUpdateLessonLog 内で _editingLogId / _editingLog はクリア済み
      restoreForm(students[currentIndex]); // pre-edit の s.data を復元
      students[currentIndex].mode = 'history';
      saveStudentsTabs();
      updateSubNavActive('history');
      showModeSection('history');
      updateEditModeUI();
    } else {
      switchMode('history'); // 新規保存時は従来通り
    }
  };

  if (!cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'action-btn action-btn-danger';
    cancelBtn.id        = 'cancel-edit-btn';
    cancelBtn.style.display = 'none'; // 通常時は非表示
    cancelBtn.innerHTML = '<i class="ti ti-x"></i> 編集をキャンセル';
    btn.insertAdjacentElement('afterend', cancelBtn);
  }

  // ── HTML既存ボタン・動的生成ボタンどちらにも必ず onclick を設定する ──
  cancelBtn.onclick = cancelEditMode;
}

/* ===========================
   初期化（DOMContentLoaded）
   — DOM構築完了後に全イベントバインドを実行
=========================== */
document.addEventListener('DOMContentLoaded', () => {

  // ── form-panel スクロールヘルパー ──
  const scrollPanelToBottom = () =>
    setTimeout(() => document.getElementById('form-panel')
      ?.scrollTo({ top: Infinity, behavior: 'smooth' }), 50);

  // ── 理解度スケールボタン ──
  document.querySelectorAll('#comp-scale .scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      document.getElementById('f-comp').value = val;
      updateScaleUI(val);
    });
  });

  // ── 担当科目チップ ──
  document.querySelectorAll('#subjects .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.val;
      if (selectedSubjects.has(val)) {
        selectedSubjects.delete(val);
        chip.classList.remove('selected');
      } else {
        selectedSubjects.add(val);
        chip.classList.add('selected');
      }
    });
  });

  // ── 生徒名入力 → タブ名同期 ──
  document.getElementById('f-name')?.addEventListener('input', e => {
    const name = e.target.value.trim();
    students[currentIndex].tabName = name || students[currentIndex].defaultName;
    const labels = document.querySelectorAll('#tab-list .tab-label');
    if (labels[currentIndex]) {
      labels[currentIndex].textContent = students[currentIndex].tabName;
    }
    saveStudentsTabs(); // タブ名（生徒名）の変更を即時永続化
  });

  // ── テスト追加ボタン ──
  // テスト追加ボタンの処理
  document.getElementById('test-add-btn')?.addEventListener('click', () => {
    const list = document.getElementById('test-list');
  
    list.querySelectorAll('.test-entry').forEach(entry => {
      entry.classList.remove('is-open');
    });

    const newIdx = list.querySelectorAll('.test-entry').length;
    list.appendChild(createTestEntryElement(createTestEntry(), newIdx));
  
    scrollPanelToBottom();
  });

  // ── 短期目標追加ボタン ──
  // 短期目標追加ボタンの処理
  document.getElementById('goal-add-btn')?.addEventListener('click', () => {
    const list   = document.getElementById('short-goal-list');
    const newIdx = list.querySelectorAll('.goal-entry').length;
    list.appendChild(createGoalEntryElement(createShortTermGoalEntry(), newIdx));

    scrollPanelToBottom();
  });

  /* ===========================
     AI診断レポートを生成する（日付選択 ＆ 構造化出力で100%安定化）
  =========================== */
  document.getElementById('gen-btn')?.addEventListener('click', async () => {
    const apiKey = document.getElementById('api-key')?.value.trim();
    if (!apiKey) { showApiKeyError(); return; }

    const btn = document.getElementById('gen-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader-2"></i> AIが分析中...';
    setLoadingText('AIが分析中です...', 'しばらくお待ちください');

    const formData = buildFormData();
    const lessonDate = getVal('lesson-date') || getLocalDate(); 
    const studentId  = 'std_' + students[currentIndex].id;
  
    const pastData     = getStudentData(studentId);
    const previousLogs = pastData ? pastData.lessonLogs.slice(-10) : [];
    const lastDiag     = (pastData && pastData.aiDiagnostics.length > 0)
      ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1]
      : null;

    // 理解度の傾向を数値計算（全ログの前半平均 vs 後半平均で比較）
    const compValues = (pastData ? pastData.lessonLogs : [])
      .map(l => parseComprehension(l.comprehension))
      .filter(v => v > 0);
    let compTrendText = '記録なし';
    if (compValues.length >= 2) {
      const half   = Math.ceil(compValues.length / 2);
      const avgOld = (compValues.slice(0, half).reduce((a, b) => a + b, 0) / half).toFixed(1);
      const avgNew = (compValues.slice(-half).reduce((a, b) => a + b, 0) / half).toFixed(1);
      const diff   = (Number(avgNew) - Number(avgOld)).toFixed(1);
      const arrow  = Number(diff) > 0.5 ? '上昇傾向↑' : Number(diff) < -0.5 ? '低下傾向↓' : '横ばい→';
      compTrendText = `${arrow}（前半平均 ${avgOld} → 後半平均 ${avgNew}、変化 ${Number(diff) >= 0 ? '+' : ''}${diff}、全${compValues.length}件）`;
    }

    // AI診断スコアの前回比
    const scoreDiffText = (pastData && pastData.aiDiagnostics.length > 1 && lastDiag)
      ? (() => {
          const prev = pastData.aiDiagnostics[pastData.aiDiagnostics.length - 2];
          const currentScore = Number(lastDiag.overallScore) || 0;
          const prevScore = Number(prev?.overallScore) || 0;
          const d = currentScore - prevScore;
          return `${d >= 0 ? '+' : ''}${d}（前回 ${prevScore} → 直近 ${currentScore}）`;
        })()
      : '初回診断のため比較なし';

    const prompt = `
  あなたはプロの教育コンサルタント・塾講師です。
  生徒の基本情報、過去の学習変化、今回の授業内容を踏まえ、保護者も納得する高品質な診断レポートを作成してください。

  【生徒情報】
  名前: ${formData.name}
  学年: ${formData.grade}
  担当科目: ${formData.subjects}
  【目標】
  長期目標: ${formData.goal}
  短期目標:
  ${formData.shortTermGoals}
  現在の課題: ${formData.concerns}

  【学習傾向分析（数値）】
  理解度の傾向: ${compTrendText}
  AI診断スコアの変化: ${scoreDiffText}

  【前回のAI診断結果】
  ${lastDiag ? `前回の総合スコア: ${lastDiag.overallScore} / 5\n前回の所見: ${lastDiag.overallComment}` : '過去のAI診断履歴はありません（初回診断）'}

  【直近の指導経過（最大10件）】
  ${previousLogs.length > 0 ? previousLogs.map((log, index) => `
  ${index + 1}. [${log.date}] 科目: ${log.subject} / 理解度: ${parseComprehension(log.comprehension)}/10
     所見: ${log.instructorNotes}
  `).join('') : '過去の授業ログはありません'}

  【今回の授業レポート (${lessonDate})】
  実施授業内容: ${formData.lessonContent}
  理解度（10段階）: ${formData.comp}
  テスト・単元結果: ${formData.scores}
  学習態度・自習状況: ${formData.attitude}
  講師メモ: ${formData.notes}

  【指示】
  - 学習傾向分析の数値（理解度の傾向・スコア変化）を必ず言及し、変化を具体的に評価してください。
  - 過去のデータと比較し、「成長できた点」「継続して取り組む課題」を具体的に述べてください。
  - 複数の科目が含まれる場合は、全体をぼやかさず「【英語】〇〇」「【数学】〇〇」のように科目ごとに明確に見出しをつけて具体的に診断してください。
  - 次回授業プランは今回の課題を踏まえ、科目ごとに単元名・教材名・つまずきやすい箇所を明記してください。
  - 保護者向けメッセージは丁寧で前向き、そのまま面談や連絡帳で渡せるクオリティにしてください。
  - 短期目標の達成状況・進捗を具体的に評価し、「今すぐ取り組むべきこと」に反映してください。
  - 週間プラン・月間プランは、科目ごとのバランスを考慮し、短期目標の達成ステップと長期目標への道筋を構成してください。
  `.trim();

    try {
      showState('state-loading');
      // 共通関数を呼び出す（最大3回まで自動で再試行してくれます）
      const data = await fetchGeminiWithRetry(apiKey, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              overallScore: { type: "INTEGER", minimum: 1, maximum: 5 },
              overallComment: { type: "STRING" },
              strengths: { type: "ARRAY", items: { type: "STRING" } },
              improvements: { type: "ARRAY", items: { type: "STRING" } },
              weeklyPlan: { type: "STRING" },
              monthlyPlan: { type: "STRING" },
              nextLessonPlan: {
                type: "OBJECT",
                properties: {
                  objective: { type: "STRING" },
                  keyPoints: { type: "ARRAY", items: { type: "STRING" } },
                  materials: { type: "STRING" },
                  pitfalls:  { type: "ARRAY", items: { type: "STRING" } }
                },
                required: ["objective", "keyPoints", "materials", "pitfalls"]
              },
              instructorAdvice: { type: "STRING" },
              parentMessage: { type: "STRING" },
              urgentAction: { type: "STRING" }
            },
            required: [
              "overallScore", "overallComment", "strengths", "improvements",
              "weeklyPlan", "monthlyPlan", "nextLessonPlan",
              "instructorAdvice", "parentMessage", "urgentAction"
            ]
          }
        }
      });

      const result = parseGeminiResponse(data);
      // API通信成功後に授業ログと診断結果を保存する
      saveOrUpdateLessonLog(studentId, formData, lessonDate);

      addAIDiagnostics(studentId, result);

      students[currentIndex].result         = result;
      students[currentIndex].lastResultType = 'diagnosis';
      renderResult(result, formData);
      showState('state-result');
      resetLessonContentField();   // 追加

    } catch (err) {
      showInlineError(
        '診断の生成に失敗しました。APIキーとネットワーク接続を確認してください。<br>' +
        `<small>${escapeHtml(err.message)}</small>`
      );
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-sparkles"></i> AI診断レポートを生成する';
    }
  });

  /* ===========================
     Step 5: 次回授業案を生成する（軽量プロンプト / maxOutputTokens:800）
  =========================== */
  document.getElementById('next-lesson-btn')?.addEventListener('click', async () => {
    const apiKey = document.getElementById('api-key')?.value.trim();
    if (!apiKey) { showApiKeyError(); return; }

    const btn = document.getElementById('next-lesson-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader-2"></i> 授業案を作成中...';
    setLoadingText('次回授業案を作成中...', 'しばらくお待ちください');

    const formData   = buildFormData();
    const lessonDate = getVal('lesson-date') || getLocalDate();
    const studentId  = 'std_' + students[currentIndex].id;
    const pastData   = getStudentData(studentId);
    const recentLogs = pastData ? pastData.lessonLogs.slice(-5) : [];

    const prompt = `
  あなたはベテラン塾講師です。
  以下の授業履歴と今回の指導記録をもとに、次回授業の具体的な指導案を作成してください。
  総合診断・保護者向けコメント・月間計画は不要です。授業計画のみに特化して回答してください。

  【生徒情報】
  名前: ${formData.name}
  学年: ${formData.grade}
  担当科目: ${formData.subjects}
  【目標】
  長期目標: ${formData.goal}
  短期目標:
  ${formData.shortTermGoals}
  現在の課題: ${formData.concerns}

  【直近の授業履歴（最大5件）】
  ${recentLogs.length > 0
    ? recentLogs.map((log, i) =>
        `${i + 1}. [${log.date}] 科目: ${log.subject} / 理解度: ${parseComprehension(log.comprehension)}/10\n   メモ: ${log.instructorNotes}`
      ).join('\n')
    : '過去の授業ログはありません'}

  【今回の授業（${lessonDate}）】
  実施授業内容: ${formData.lessonContent}
  理解度（10段階）: ${formData.comp}
  テスト・単元結果: ${formData.scores}
  学習態度: ${formData.attitude}
  講師メモ: ${formData.notes}

  【指示】
  - 今回の理解度・課題を踏まえ、次回の授業目標を1文で端的に示してください。
  - 複数の科目が含まれる場合は、重点指導ポイント、教材、宿題、つまずきやすい箇所を「【英語】〇〇」「【数学】〇〇」のように科目別に分けて明確に記載してください。
  - 重点指導ポイントは科目ごとに具体的に単元名・問題タイプを挙げてください。
  - 使用する教材・参考書・ページ数を具体的に記載してください。
  - 生徒がつまずきやすい箇所と講師がとるべき対処法を明記してください。
  - 次回授業前に出す宿題・自習課題を具体的に提示してください。
  - 指導のヒントとして、この生徒への効果的なアプローチを1〜2文で示してください。
  - 短期目標の期限が近い場合は、その達成を最優先した集中指導プランを示してください。
  `.trim();

    try {
      showState('state-loading');
      // 共通関数を呼び出す（最大3回まで自動で再試行してくれます）
      const data = await fetchGeminiWithRetry(apiKey, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              objective:    { type: 'STRING' },
              keyPoints:    { type: 'ARRAY', items: { type: 'STRING' } },
              materials:    { type: 'STRING' },
              pitfalls:     { type: 'ARRAY', items: { type: 'STRING' } },
              homework:     { type: 'STRING' },
              teachingTips: { type: 'STRING' }
            },
            required: ['objective', 'keyPoints', 'materials', 'pitfalls', 'homework', 'teachingTips']
          }
        }
      });

      const result = parseGeminiResponse(data);

      students[currentIndex].lessonPlanResult = result;
      students[currentIndex].lastResultType   = 'lessonplan';
      renderLessonPlanResult(result, formData);
      showState('state-result');
      saveOrUpdateLessonLog(studentId, formData, lessonDate);
      resetLessonContentField();   // 追加

    } catch (err) {
      showInlineError(
        '次回授業案の生成に失敗しました。APIキーとネットワーク接続を確認してください。<br>' +
        `<small>${escapeHtml(err.message)}</small>`
      );
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-calendar-event"></i> 次回授業案を生成';
    }
  });

  /* ===========================
     タブ・データ管理ボタン
  =========================== */
  document.getElementById('tab-add-btn')?.addEventListener('click', addStudent);

  document.getElementById('tab-summary-btn')?.addEventListener('click', renderSummaryPanel);
  document.getElementById('tab-export-btn')?.addEventListener('click', exportAllData);
  document.getElementById('tab-import-btn')?.addEventListener('click', () => {
    document.getElementById('import-file-input')?.click();
  });
  document.getElementById('import-file-input')?.addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // 基本情報「変更」ボタン: 生徒名・学年のロックを一時解除する
  document.getElementById('basic-info-unlock-btn')?.addEventListener('click', () => {
    const nameInput   = document.getElementById('f-name');
    const gradeSelect = document.getElementById('f-grade');
    const unlockBtn   = document.getElementById('basic-info-unlock-btn');

    if (nameInput) {
      nameInput.disabled = false;
      nameInput.closest('.field')?.classList.remove('field-locked');
      nameInput.focus();
    }
    if (gradeSelect) {
      gradeSelect.disabled = false;
      gradeSelect.closest('.field')?.classList.remove('field-locked');
    }
    if (unlockBtn) {
      unlockBtn.style.display = 'none';
    }
  });

  injectSubNavStyles();
  renderSubNav();
  initSections();
  initStudents(); // localStorage からタブ一覧・基本情報を復元（ページリロード対策）
  renderTabs();
  restoreForm(students[currentIndex]);
  injectSaveLogButton();

  /* ===========================
     APIキー 表示/非表示トグル
  =========================== */
  document.getElementById('api-key-toggle')?.addEventListener('click', () => {
    const input   = document.getElementById('api-key');
    const icon    = document.querySelector('#api-key-toggle .ti');
    const isHidden = input.type === 'password';
    input.type    = isHidden ? 'text' : 'password';
    icon.className = `ti ${isHidden ? 'ti-eye-off' : 'ti-eye'}`;
  });

  /* ===========================
     APIキーの永続化
     - ページ読み込み時に localStorage から自動復元
     - 入力変更のたびに localStorage へ保存（空の場合は削除）
  =========================== */
  (function initApiKeyPersistence() {
    const apiKeyEl = document.getElementById('api-key');
    if (!apiKeyEl) return;

    // 復元
    const saved = localStorage.getItem('gemini_api_key');
    if (saved) apiKeyEl.value = saved;

    // 自動保存
    apiKeyEl.addEventListener('input', () => {
      const val = apiKeyEl.value.trim();
      if (val) {
        localStorage.setItem('gemini_api_key', val);
      } else {
        localStorage.removeItem('gemini_api_key');
      }
    });
  })();

  /* ===========================
     理解度グラフのリサイズ対応
     - ウィンドウ幅が変わったとき、グラフが表示中であれば再描画する
     - デバウンス 150ms でパフォーマンスを確保
  =========================== */
  window.addEventListener('resize', () => {
    clearTimeout(_chartResizeTimer);
    _chartResizeTimer = setTimeout(() => {
      const canvas = document.getElementById('comp-chart');
      // Canvasが表示されている（幅を持っている）場合のみ再描画する
      if (canvas && canvas.offsetWidth > 0 && _chartLogs) {
        drawComprehensionChart(_chartLogs);
      }
    }, 150);
  });

}); // end DOMContentLoaded
