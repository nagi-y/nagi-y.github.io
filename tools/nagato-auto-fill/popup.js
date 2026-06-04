document.addEventListener('DOMContentLoaded', function () {
    const config = window.NAGATO_FORM_CONFIG || { templates: {} };
    const templates = config.templates || {};

    const dateInput = document.getElementById('dateInput');
    const startTimeInput = document.getElementById('startTime');
    const endTimeInput = document.getElementById('endTime');
    const group = document.getElementById('templateGroup');
    const statusEl = document.getElementById('status');

    // 今日の日付をデフォルトセット
    dateInput.value = new Date().toISOString().split('T')[0];

    // --- 種別ラジオを config から動的生成 ---
    const keys = Object.keys(templates);
    keys.forEach((key, i) => {
        const t = templates[key];
        const label = document.createElement('label');
        label.className = 'radio-label';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'template';
        radio.value = key;
        if (i === 0) radio.checked = true;
        radio.addEventListener('change', () => applyTime(key));

        label.appendChild(radio);
        label.appendChild(document.createTextNode(' ' + (t.label || key)));
        group.appendChild(label);
    });

    // --- 選択中の種別の時間をフォームに反映 ---
    function applyTime(key) {
        const t = templates[key];
        if (!t) return;
        if (t.startTime) startTimeInput.value = t.startTime;
        if (t.endTime) endTimeInput.value = t.endTime;
    }

    // 初期表示：先頭の種別の時間をセット
    if (keys.length > 0) {
        applyTime(keys[0]);
    } else {
        statusEl.innerText = "⚠️ config.js に templates がありません";
    }

    // --- 実行 ---
    document.getElementById('fillBtn').addEventListener('click', () => {
        const dateVal = dateInput.value;     // YYYY-MM-DD
        const startVal = startTimeInput.value; // HH:mm
        const endVal = endTimeInput.value;     // HH:mm
        const checkedRadio = document.querySelector('input[name="template"]:checked');
        const template = checkedRadio ? checkedRadio.value : (keys[0] || "");
        const isDebug = document.getElementById('debugMode').checked;

        if (!dateVal || !startVal || !endVal) {
            statusEl.innerText = "⚠️ 日時をすべて入力してください";
            return;
        }

        // content.js に送る形式 (YYYY-MM-DD HH:mm)
        const startDate = `${dateVal} ${startVal}`;
        const endDate = `${dateVal} ${endVal}`;

        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs.length === 0) return;

            chrome.tabs.sendMessage(tabs[0].id, {
                action: "fill_form",
                data: { startDate, endDate, template, debug: isDebug }
            }, function (response) {
                if (chrome.runtime.lastError) {
                    statusEl.innerText = "エラー: ページをリロードしてください";
                } else if (response && response.status === "success") {
                    statusEl.innerText = "✅ 入力完了！";
                    setTimeout(() => window.close(), 1000);
                }
            });
        });
    });
});