chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === "fill_form") {
        runFill(request.data);
        sendResponse({ status: "success" });
    }
});

// ==========================================================
// 2ページ構成対応 (v3.1)
//   このフォームは「メール+同意 → 次へ → 本体」の2ページ構成。
//   1ページ目で実行された場合はメール・同意を入力して「次へ」を
//   自動クリックし、遷移先で残りを自動入力する（意図は
//   sessionStorage 経由で持ち越す。送信は必ず人間が押す）。
// ==========================================================
const NAGATO_PENDING_KEY = "nagatoAutoFillPending";

function nagatoFindNavButton(label) {
    return Array.from(document.querySelectorAll('[role="button"]'))
        .find(b => (b.innerText || "").trim() === label);
}

function nagatoIsPage1() {
    // 「次へ」ボタンがある間は1ページ目（2ページ目は「送信」「戻る」）
    return !!nagatoFindNavButton("次へ");
}

function runFill(data) {
    const engine = new FormEngine(data);
    engine.run();

    if (nagatoIsPage1()) {
        sessionStorage.setItem(NAGATO_PENDING_KEY, JSON.stringify(data));
        const next = nagatoFindNavButton("次へ");
        // 同意チェックの反映を待ってから遷移
        if (next) setTimeout(() => next.click(), 400);
    }
}

// ページ読み込み時: 1ページ目からの持ち越しがあれば2ページ目を自動入力
(function nagatoResumePendingFill() {
    let raw = null;
    try { raw = sessionStorage.getItem(NAGATO_PENDING_KEY); } catch (e) { return; }
    if (!raw) return;
    if (nagatoIsPage1()) return; // 遷移に失敗して1ページ目のまま（同意未入力等）

    sessionStorage.removeItem(NAGATO_PENDING_KEY);
    const start = () => {
        try { runFill(JSON.parse(raw)); } catch (e) { console.warn("nagato-auto-fill: 持ち越し入力に失敗", e); }
    };
    // フォーム描画完了を待つ
    if (document.readyState === "complete") setTimeout(start, 600);
    else window.addEventListener("load", () => setTimeout(start, 600));
})();

// ==========================================================
// FormEngine
//   - 構造は新版（クラス型・Engine/Config分離）
//   - 入力ロジックは旧版 v2.4 の動作実績版を移植
//   - 設定は window.NAGATO_FORM_CONFIG (config.js) を参照
// ==========================================================
class FormEngine {
    constructor(data) {
        this.data = data;
        this.isDebug = data.debug === true;

        const config = window.NAGATO_FORM_CONFIG || {
            templates: {}, staticValues: {}, matrixFixedValues: {}
        };
        this.config = config;

        const templates = config.templates || {};
        // 指定テンプレ → 無ければ先頭 → それも無ければ空
        this.template = templates[data.template]
            || Object.values(templates)[0]
            || { purpose: "", food: "無し", entryFee: "無し", facility: "", freeText: "" };

        // --- 通常項目マップ（ブロックタイトル部分一致 → 値） ---
        this.simpleMap = {
            ...config.staticValues,
            // ★種別ごとの施設。テンプレ未指定なら staticValues の値を残す（旧config互換）
            "使用施設名": this.template.facility || config.staticValues["使用施設名"] || "",
            "使用目的": this.template.purpose,
            "フリー欄": this.template.freeText,
            "使用開始予定日時": data.startDate,
            "使用終了予定日時": data.endDate
        };

        // --- マトリックス（「内容について」）マップ ---
        this.matrixMap = {
            ...config.matrixFixedValues,
            "入場料": this.template.entryFee,
            "飲食": this.template.food
        };
    }

    // --- ロガー（Debug Mode時のみ出力） ---
    log(...a) { if (this.isDebug) console.log(...a); }
    warn(...a) { if (this.isDebug) console.warn(...a); }
    group(...a) { if (this.isDebug) console.groupCollapsed(...a); }
    groupEnd() { if (this.isDebug) console.groupEnd(); }
    clear() { if (this.isDebug) console.clear(); }

    // --- メイン ---
    run() {
        this.clear();
        this.log("%c🚀 START: フォーム自動入力 (v3.0 / config連携)",
            "color:#00ff00;font-weight:bold;font-size:14px;");
        this.log("📌 テンプレート:", this.data.template, this.template);

        // 独立したメールアドレス欄（ブロック外）
        const emailInput = document.querySelector('input[type="email"]');
        if (emailInput && this.simpleMap["メールアドレス"]) {
            this.setInput(emailInput, this.simpleMap["メールアドレス"]);
            this.log("📧 メールアドレス(独立欄)に入力");
        }

        const items = document.querySelectorAll('[role="listitem"]');
        this.log(`🔍 探索開始: ${items.length} 個のブロックを検出`);

        items.forEach((item, index) => {
            const titleEl = item.querySelector('[role="heading"]');
            if (!titleEl) return;
            const title = titleEl.textContent.trim();

            this.group(`Block #${index}: ${title.substring(0, 15)}...`);

            // 画像案内ブロックはスキップ
            if (title.includes("ご利用時間について")) {
                this.log("ℹ️ 画像ブロックのためスキップ");
                this.groupEnd();
                return;
            }

            // 「内容について」= マトリックス設問
            if (title.includes("内容について")) {
                this.handleMatrixBlock(item, this.matrixMap);
                this.groupEnd();
                return;
            }

            // 減免申請（単独ラジオ）
            if (title.includes("減免申請")) {
                const val = this.simpleMap["減免申請"];
                if (val) this.handleSimpleRadio(item, val);
                this.groupEnd();
                return;
            }

            // 通常マッピング
            for (const [key, value] of Object.entries(this.simpleMap)) {
                if (!title.includes(key)) continue;
                this.log(`🎯 キーヒット: "${key}"`);

                // 日時（"YYYY-MM-DD HH:mm" を分割対応）
                if (key.includes("日時")) {
                    this.handleDateTime(item, value);
                    continue;
                }

                if (value === "") continue;

                // チェックボックス / ラジオ
                const checks = item.querySelectorAll('[role="checkbox"], [role="radio"]');
                if (checks.length > 0) {
                    if (value === true) {
                        if (checks[0].getAttribute('aria-checked') !== 'true') checks[0].click();
                        this.log("   ✅ 最初の項目を選択(true)");
                    } else {
                        let matched = false;
                        checks.forEach(c => {
                            const cLabel = c.getAttribute('aria-label') || c.dataset.value || "";
                            if (cLabel.includes(value)) {
                                if (c.getAttribute('aria-checked') !== "true") c.click();
                                this.log(`   ✅ 選択実行: "${value}"`);
                                matched = true;
                            }
                        });
                        if (!matched) this.warn(`   ⚠️ 選択肢が見つかりません: ${value}`);
                    }
                }

                // テキスト入力 / テキストエリア
                const input = item.querySelector(
                    'input:not([type="hidden"]):not([type="date"]):not([type="time"]):not([type="checkbox"]):not([type="radio"]), textarea'
                );
                if (input) this.setInput(input, value);
            }

            this.groupEnd();
        });

        this.log("%c✅ 完了", "color:#00ff00;font-weight:bold;");
    }

    // --- 日時（3分割 / 2分割 / 1欄 に柔軟対応） ---
    handleDateTime(item, value) {
        const inputs = item.querySelectorAll('input:not([type="hidden"])');
        const [datePart, timePart] = String(value).split(' ');
        const [hh, mm] = (timePart || "").split(':');

        if (inputs.length === 3) {
            this.setInput(inputs[0], datePart);
            this.setInput(inputs[1], hh);
            this.setInput(inputs[2], mm);
            this.log("   ⏰ 3分割入力 (日付/時/分)");
        } else if (inputs.length === 2) {
            this.setInput(inputs[0], datePart);
            this.setInput(inputs[1], `${hh}:${mm}`);
            this.log("   ⏰ 2分割入力 (日付/時刻)");
        } else if (inputs.length === 1) {
            this.setInput(inputs[0], value);
            this.log("   ⏰ 1欄入力");
        }
    }

    // --- マトリックス: aria-labelスナイパー（行名+値で直接特定） ---
    handleMatrixBlock(blockElement, mapData) {
        this.log("👉 マトリックス処理(ラベル照合モード)");
        const allOptions = blockElement.querySelectorAll('div[role="checkbox"], div[role="radio"]');

        Object.keys(mapData).forEach(rowKey => {
            const targetValue = mapData[rowKey];
            let clicked = false;

            for (const option of allOptions) {
                const label = option.getAttribute('aria-label') || "";
                if (label.includes(rowKey) && label.includes(targetValue)) {
                    if (option.getAttribute('aria-checked') !== 'true') {
                        option.click();
                        this.log(`   ✅ [${rowKey}] -> ${targetValue}`);
                    } else {
                        this.log(`   ℹ️ [${rowKey}] は既に選択済み`);
                    }
                    clicked = true;
                    break;
                }
            }

            if (!clicked) {
                const ok = this.manualGridSearch(blockElement, rowKey, targetValue);
                if (!ok) this.warn(`   ⚠️ ボタン特定失敗: [${rowKey}] -> ${targetValue}`);
            }
        });
    }

    // --- マトリックス フォールバック（行コンテナ内の位置で推定） ---
    manualGridSearch(blockElement, rowKey, targetValue) {
        const texts = Array.from(blockElement.querySelectorAll('div'))
            .filter(el => el.innerText && el.innerText.trim() === rowKey);

        for (const textEl of texts) {
            const rowContainer = textEl.closest('.ssX1Bd') || textEl.parentElement;
            if (!rowContainer) continue;

            const options = rowContainer.querySelectorAll('div[role="checkbox"], div[role="radio"]');
            if (options.length >= 2) {
                let index = -1;
                if (targetValue.includes("有り") || targetValue.includes("あり")) index = 0;
                if (targetValue.includes("無し") || targetValue.includes("なし")) index = 1;

                if (index >= 0 && options[index]) {
                    options[index].click();
                    this.log(`   ✅ (Fallback) [${rowKey}] -> ${targetValue}`);
                    return true;
                }
            }
        }
        return false;
    }

    // --- 単独ラジオ ---
    handleSimpleRadio(blockElement, targetValue) {
        const radios = blockElement.querySelectorAll('div[role="radio"]');
        let clicked = false;
        for (const radio of radios) {
            const val = radio.getAttribute('data-value') || radio.getAttribute('aria-label') || radio.innerText || "";
            if (val.trim() === targetValue || val.includes(targetValue)) {
                if (radio.getAttribute('aria-checked') !== 'true') radio.click();
                this.log(`   ✅ ラジオボタン選択: "${targetValue}"`);
                clicked = true;
                break;
            }
        }
        if (!clicked) this.warn(`   ⚠️ ラジオボタンが見つかりません: "${targetValue}"`);
    }

    // --- React制御フォーム対応の入力（_valueTracker を欺く） ---
    setInput(element, value) {
        if (!element) return;
        element.focus();
        const lastValue = element.value;
        element.value = value;
        const event = new Event('input', { bubbles: true });
        const tracker = element._valueTracker;
        if (tracker) tracker.setValue(lastValue);
        element.dispatchEvent(event);
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.blur();
    }
}
