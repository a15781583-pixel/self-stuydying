/* =========================================================
   js-main.js  ─  タブ切り替え・起動処理
   ---------------------------------------------------------
   【こんなときに、このファイルを開く】
    ・タブ（スケジュール／単語設定／…）の切り替えの動きを直したい
    ・ページを開いたときの最初の処理（データ読み込み→画面表示）を直したい
   【読み込み順】 ⑧ 必ず最後（js-ai-features.js の直前）。全関数が読み込まれた後に動かすため
   ※ 中身のコードは、分割前の js-app.js と同一です（場所を移しただけ）。
========================================================= */

/* ───────── タブ切り替え・起動処理 ───────── */
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
  buildIntervalChips();
  const startDateEl = document.getElementById('startDate');
  if (startDateEl) startDateEl.value = todayISO();
  document.getElementById('addBtn')?.addEventListener('click', handleAdd);
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
  // 各ステップを個別に保護する：1つが失敗しても、後続（特にスケジュール表示）は必ず実行する
  const safe = async (label, fn) => {
    try { await fn(); } catch (e) { console.error('[init] ' + label + ' に失敗:', e); }
  };

  await safe('復習完了データの読込', () => loadReviewDone());
  await safe('日別進捗の読込', () => loadDailyProgress());
  await safe('単語データの読込', () => loadEntries());
  await safe('単語一覧の描画', () => renderAll());
  await safe('参考書データの読込', () => loadRefEntries()); // 参考書データを先に読み込む（DOMContentLoadedから移動）
  await safe('統合スケジュールの描画', () => renderIntegratedSchedule()); // 「スケジュール」タブは初期表示タブなので、読み込み直後に描画する
  await safe('月目標カードの描画', () => {
    renderMonthGoalCard();      // 月目標カードを初期表示
    document.getElementById('monthGoalEditBtn')?.addEventListener('click', openMonthGoalEditor);
    document.getElementById('monthGoalSaveBtn')?.addEventListener('click', handleMonthGoalSave);
    document.getElementById('monthGoalCancelBtn')?.addEventListener('click', closeMonthGoalEditor);
  });
  await safe('苦手単語の読込・描画', async () => {
    await loadLeech();
    renderLeech();
  });

  // ---- 成績・弱点分析タブの初期化 ----
  await safe('成績・弱点分析タブの初期化', async () => {
    const scoreDateEl = document.getElementById('scoreDate');
    if(scoreDateEl) scoreDateEl.value = todayISO();
    // scoreAddBtn はjs-test.js定義のhandleScoreAddを使うためここで登録
    if(document.getElementById('scoreAddBtn')) document.getElementById('scoreAddBtn').addEventListener('click', handleScoreAdd);
    // handleScoreImageFile / runWeaknessAnalysis はjs-ai-features.jsのinitAiFeatures()が担当
    await loadScores();
    renderScoreList();
    try {
      const savedAnalysis = localStorage.getItem(ANALYSIS_KEY);
      // renderAnalysisResultはjs-ai-features.jsで定義されるためtypeof守衛
      if(savedAnalysis && typeof renderAnalysisResult === 'function') renderAnalysisResult(JSON.parse(savedAnalysis).result);
    } catch(e) {}
  });
})();