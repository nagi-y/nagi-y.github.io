chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === "fill_form") {
        const engine = new FormEngine(req.data);
        engine.run();
        sendResponse({status: "success"});
    }
});

// ==========================================
// [ZONE A] CUSTOM CONFIGURATION (ここだけ編集)
// ==========================================
const FormConfig = {
    // 1. テンプレート定義 (popupから送られる template ID に対応)
    templates: {
        patternA: { 
            purpose: "会議利用",
            option1: "有り",
            memo: "プロジェクター希望"
        },
        patternB: { 
            purpose: "セミナー利用",
            option1: "無し",
            memo: "" 
        }
    },

    // 2. マッピング定義
    // Key: フォームの質問文（部分一致OK）
    // Value: 入力値、またはテンプレート変数の参照
    // 特殊動作:
    //  - null/empty string: スキップ
    //  - Object: マトリックス（グリッド）設問として処理
    mapping: (data, currentTemplate) => ({
        // --- 基本情報 ---
        "メールアドレス": "example@email.com",
        "氏名": "山田 太郎",
        
        // --- テンプレート連動 ---
        "利用目的": currentTemplate.purpose,
        "備考": currentTemplate.memo,
        
        // --- 日時 (popupからのデータ) ---
        // inputが複数ある場合、自動で分割入力されます
        "使用開始日時": data.startDate, // "2025-12-01 13:00"
        "使用終了日時": data.endDate,

        // --- マトリックス (グリッド) ---
        // 質問タイトル: { 行のラベル: 選択したい値 }
        "設備について": {
            "机": "有り",
            "椅子": "有り",
            "ホワイトボード": currentTemplate.option1
        },

        // --- ラジオボタン/チェックボックス ---
        "同意しますか": "はい",
        "減免申請": "あり" 
    })
};

// ==========================================
// [ZONE B] UNIVERSAL ENGINE (編集不要)
// ==========================================
class FormEngine {
    constructor(data) {
        this.data = data;
        this.isDebug = data.debug;
        this.template = FormConfig.templates[data.template] || Object.values(FormConfig.templates)[0];
        this.map = FormConfig.mapping(data, this.template);
    }

    log(...args) { if (this.isDebug) console.log(...args); }
    warn(...args) { if (this.isDebug) console.warn(...args); }
    group(...args) { if (this.isDebug) console.groupCollapsed(...args); }
    groupEnd() { if (this.isDebug) console.groupEnd(); }

    run() {
        console.clear();
        this.log("%c🚀 FormEngine Started", "color: #00ff00; font-weight: bold;");
        
        // 独立したメールアドレス欄などの特別対応
        this.fillStandaloneInputs();

        // ブロックごとの処理
        const blocks = document.querySelectorAll('[role="listitem"]');
        this.log(`Found ${blocks.length} blocks.`);

        blocks.forEach((block, idx) => {
            const titleEl = block.querySelector('[role="heading"]');
            if (!titleEl) return;
            
            const title = titleEl.textContent.trim();
            this.group(`Block #${idx}: ${title.substring(0, 20)}...`);

            // マッピングとの照合
            let processed = false;
            for (const [key, value] of Object.entries(this.map)) {
                if (title.includes(key)) {
                    this.log(`🎯 Hit Config Key: "${key}"`);
                    this.processBlock(block, value);
                    processed = true;
                    // 1つのブロックに複数の設定がヒットする可能性は低いが、
                    // 詳細な制御が必要な場合は break するか検討
                }
            }
            if (!processed) this.log("ℹ️ No config matched.");
            this.groupEnd();
        });
    }

    fillStandaloneInputs() {
        // 特別なinput（ブロック外にあるemail等）
        const emailInput = document.querySelector('input[type="email"]');
        if (emailInput && this.map["メールアドレス"]) {
            this.setInput(emailInput, this.map["メールアドレス"]);
            this.log("📧 Filled standalone email");
        }
    }

    processBlock(block, value) {
        if (!value) return;

        // 1. マトリックス (Objectの場合)
        if (typeof value === 'object' && value !== null) {
            this.handleMatrix(block, value);
            return;
        }

        // 2. 日時 (inputが複数ある場合)
        const textInputs = block.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
        if (textInputs.length >= 2 && (typeof value === 'string' && value.includes(' '))) {
            this.handleDateTime(textInputs, value);
            return;
        }

        // 3. テキスト入力
        const textInput = block.querySelector('input[type="text"], input[type="email"], textarea');
        if (textInput) {
            this.setInput(textInput, value);
            this.log(`✏️ Input text: ${value}`);
            return;
        }

        // 4. ラジオ/チェックボックス
        this.handleSelection(block, value);
    }

    handleMatrix(block, rowMap) {
        this.log("👉 Matrix Mode (Sniper Logic)");
        const options = block.querySelectorAll('div[role="radio"], div[role="checkbox"]');
        
        Object.keys(rowMap).forEach(rowKey => {
            const targetVal = rowMap[rowKey];
            let hit = false;
            
            for (const opt of options) {
                const label = opt.getAttribute('aria-label') || "";
                // 行名と値の両方が含まれているものを探す (Sniper)
                if (label.includes(rowKey) && label.includes(targetVal)) {
                    if (opt.getAttribute('aria-checked') !== 'true') opt.click();
                    this.log(`   ✅ ${rowKey} -> ${targetVal}`);
                    hit = true;
                    break;
                }
            }
            if (!hit) this.warn(`   ⚠️ Failed to find: ${rowKey} -> ${targetVal}`);
        });
    }

    handleSelection(block, targetVal) {
        const options = block.querySelectorAll('div[role="radio"], div[role="checkbox"]');
        if (options.length === 0) return;

        if (targetVal === true) {
            // trueなら先頭をクリック（「同意する」など）
            options[0].click();
            this.log("   ✅ Selected first option (true)");
        } else {
            let hit = false;
            options.forEach(opt => {
                const label = opt.getAttribute('aria-label') || opt.dataset.value || opt.innerText || "";
                if (label.includes(targetVal)) {
                    if (opt.getAttribute('aria-checked') !== 'true') opt.click();
                    this.log(`   ✅ Selected: ${targetVal}`);
                    hit = true;
                }
            });
            if (!hit) this.warn(`   ⚠️ Option not found: ${targetVal}`);
        }
    }

    handleDateTime(inputs, value) {
        // value format: "YYYY-MM-DD HH:mm"
        const [date, time] = value.split(' ');
        const [hh, mm] = time ? time.split(':') : ["00", "00"];
        
        if (inputs.length === 3) {
            // Date, Hour, Min
            this.setInput(inputs[0], date);
            this.setInput(inputs[1], hh);
            this.setInput(inputs[2], mm);
            this.log("   ⏰ Filled 3 fields (Date, HH, MM)");
        } else if (inputs.length === 2) {
            // Date, Time
            this.setInput(inputs[0], date);
            this.setInput(inputs[1], `${hh}:${mm}`);
            this.log("   ⏰ Filled 2 fields (Date, Time)");
        }
    }

    setInput(el, val) {
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
    }
}
