import { getContext, /*...*/ } from '../../../../script.js';
import { eventSource, event_types } from '../../../../script.js';
import { renderExtensionTemplateAsync } from "../../../extensions.js";

const pluginName = 'time-UI-1';
const pluginId = 'daily-usage-tracker'; // *** 必须与服务器插件 ID 一致 ***
const serverApiBase = `/api/plugins/${pluginId}`;

// --- 全局变量 (插件作用域内) ---
let currentCharacterId = null;
let activeStartTime = null;
let isWindowFocused = true;
let localAccumulatedStats = {}; // { [charId]: { timeMs: 0, msgInc: 0, wordInc: 0 } }
const syncInterval = 1 * 60 * 1000; // 每 1 分钟尝试同步一次累积数据
let syncIntervalId = null;

// --- 辅助函数 ---

function getBeijingDateStringClient() {
    // ... (同上一个前端版本) ...
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDuration(ms) {
    // ... (同上一个前端版本) ...
    if (isNaN(ms) || ms < 0) return '0:00:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * 初始化或获取指定角色的本地累积统计对象
 * @param {string} charId
 * @returns {object}
 */
function getOrCreateAccumulator(charId) {
    if (!charId) return null;
    if (!localAccumulatedStats[charId]) {
        localAccumulatedStats[charId] = { timeMs: 0, msgInc: 0, wordInc: 0 };
    }
    return localAccumulatedStats[charId];
}

/**
 * 累积时间增量到本地缓存
 */
function accumulateTime() {
    if (!isWindowFocused || !activeStartTime || !currentCharacterId) {
        return; // 不在活跃状态，不累积
    }
    const accumulator = getOrCreateAccumulator(currentCharacterId);
    if (!accumulator) return;

    const now = Date.now();
    const durationMs = now - activeStartTime;
    if (durationMs > 0) { // 只有当有实际时长时才累加
        accumulator.timeMs += durationMs;
        // console.log(`Accumulated time for ${currentCharacterId}: +${durationMs}ms, total buffered: ${accumulator.timeMs}ms`);
    }
    activeStartTime = now; // 重置开始时间，为下一次增量计算做准备
}

/**
 * 累积消息和字数增量到本地缓存
 * @param {number} msgInc - 消息增量 (通常是 1)
 * @param {number} wordInc - 字数增量
 */
function accumulateMessage(msgInc = 0, wordInc = 0) {
    if (!currentCharacterId) return;
    const accumulator = getOrCreateAccumulator(currentCharacterId);
    if (!accumulator) return;

    accumulator.msgInc += msgInc;
    accumulator.wordInc += wordInc;
    // console.log(`Accumulated message/words for ${currentCharacterId}: +${msgInc}msg, +${wordInc}words`);
}

/**
 * 将本地累积的统计数据发送到服务器
 */
async function syncAccumulatedData() {
    const charIdsToSend = Object.keys(localAccumulatedStats).filter(charId =>
        localAccumulatedStats[charId].timeMs > 0 ||
        localAccumulatedStats[charId].msgInc > 0 ||
        localAccumulatedStats[charId].wordInc > 0
    );

    if (charIdsToSend.length === 0) {
        // console.log("No accumulated data to sync.");
        return;
    }

    console.log(`Syncing accumulated data for characters: ${charIdsToSend.join(', ')}`);

    const sendPromises = charIdsToSend.map(async (charId) => {
        const dataToSend = { ...localAccumulatedStats[charId] }; // 复制一份待发送数据
        if(dataToSend.timeMs < 0 || dataToSend.msgInc < 0 || dataToSend.wordInc < 0) {
            console.warn(`Negative accumulated value detected for ${charId}, skipping sync for this character.`, dataToSend);
            // 重置负值？或者记录错误？暂时跳过。
            delete localAccumulatedStats[charId]; // 防止下次还发负数
            return; // 跳过这个 characterId 的发送
        }

        const payload = {
            characterId: charId,
            ...dataToSend
        };

        try {
            const response = await fetch(`${serverApiBase}/track`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (response.ok) {
                // 发送成功，清空本地对应角色的累积数据
                console.log(`Successfully synced data for ${charId}`);
                delete localAccumulatedStats[charId]; // 或者重置为 0: localAccumulatedStats[charId] = { timeMs: 0, msgInc: 0, wordInc: 0 };
            } else {
                console.error(`Error syncing data for ${charId}: ${response.statusText}`);
                const errorBody = await response.json().catch(() => ({}));
                console.error('Server error details:', errorBody);
                // 发送失败，数据保留在 localAccumulatedStats 中，下次会重试
            }
        } catch (error) {
            console.error(`Network error syncing data for ${charId}:`, error);
            // 网络错误，数据保留，下次重试
        }
    });

    await Promise.allSettled(sendPromises); // 等待所有发送尝试完成（无论成功失败）
}

/**
 * 处理角色/群组切换
 */
function handleCharacterChange() {
    accumulateTime(); // 先累积上一个角色的最后时间
    syncAccumulatedData(); // 尝试发送所有累积数据

    const context = getContext();
    currentCharacterId = context.groupId || context.characterId; // 优先群组ID
    activeStartTime = isWindowFocused ? Date.now() : null; // 窗口聚焦才开始计时

    console.log(`Switched to character/group: ${currentCharacterId}`);
}

/**
 * 处理新消息（用户或 AI）
 * @param {object} messageData - SillyTavern 消息对象
 * @param {boolean} isUser - 是否是用户消息
 */
function handleMessage(messageData, isUser) {
    if (!currentCharacterId) return;

    const messageText = messageData?.mes || ''; // 获取消息文本
    if (!messageText) return;

    const wordCount = (messageText.match(/\S+/g) || []).length;
    accumulateMessage(1, wordCount); // 累积消息数和字数
}


/**
 * 加载并显示统计数据 (与之前版本类似)
 * @param {string} dateString
 */
async function loadAndDisplayStats(dateString) {
    // ... (加载和显示逻辑基本不变，从上一个前端版本复制过来) ...
    const displayArea = $('#stats-display-area');
    const tableBody = $('#stats-table tbody');
    displayArea.html('<p>正在加载统计数据...</p>'); // 清空并显示加载中
    tableBody.empty();

    try {
        const response = await fetch(`${serverApiBase}/stats?date=${dateString}`);
        if (!response.ok) {
            throw new Error(`获取统计数据失败: ${response.statusText}`);
        }
        const stats = await response.json();

        if (Object.keys(stats).length === 0) {
            displayArea.html('<p>该日期没有统计数据。</p>');
            // 确保表格可见但为空
            displayArea.empty().append(`
                <table id="stats-table">
                    <thead>
                        <tr>
                            <th>角色/群组</th>
                            <th>聊天时长</th>
                            <th>消息数</th>
                            <th>字数</th>
                        </tr>
                    </thead>
                    <tbody>
                        <!-- 无数据 -->
                    </tbody>
                </table>
            `);
            return;
        }

        displayArea.empty().append($('#stats-table')); // 清空加载提示，显示表格

        // 排序（可选，例如按时间或名称）
        const sortedCharIds = Object.keys(stats).sort((a, b) => (stats[b].totalTimeMs || 0) - (stats[a].totalTimeMs || 0));

        for (const charId of sortedCharIds) {
            const data = stats[charId];
            const characterName = charId; // 暂时使用 ID

            const row = `
                <tr>
                    <td>${characterName}</td>
                    <td>${formatDuration(data.totalTimeMs)}</td>
                    <td>${data.messageCount || 0}</td>
                    <td>${data.wordCount || 0}</td>
                </tr>
            `;
            tableBody.append(row);
        }

    } catch (error) {
        console.error('加载统计数据时出错:', error);
        displayArea.html(`<p class="text-danger">加载统计数据失败: ${error.message}</p>`);
    }
}

// --- 初始化 ---
jQuery(async () => {
    console.log("聊天统计插件 (优化版) 加载中...");

    // 1. 加载 UI
    try {
        const html = await renderExtensionTemplateAsync(pluginName, 'ui');
        $("#extensions_settings").append(html);
    } catch (error) {
        console.error("加载统计插件 UI 失败:", error);
        return;
    }

    // 2. 初始化 UI 和加载当天数据
    const todayString = getBeijingDateStringClient();
    $('#stats-datepicker').val(todayString);
    loadAndDisplayStats(todayString); // 初始加载

    // 3. 绑定 UI 事件
    $('#stats-refresh-button').on('click', () => {
        const selectedDate = $('#stats-datepicker').val();
        if (selectedDate) loadAndDisplayStats(selectedDate);
    });
    $('#stats-datepicker').on('change', () => {
        const selectedDate = $('#stats-datepicker').val();
        if (selectedDate) loadAndDisplayStats(selectedDate);
    });

    // 4. 获取初始角色并设置状态
    handleCharacterChange(); // 获取初始角色

    // 5. 设置定时同步器
    if (syncIntervalId) clearInterval(syncIntervalId); // 清除旧的定时器（如果存在）
    syncIntervalId = setInterval(() => {
        accumulateTime(); // 定时累积一下当前时间
        syncAccumulatedData(); // 定时尝试同步
    }, syncInterval);
    console.log(`Periodic data sync started (interval: ${syncInterval / 1000}s).`);

    // 6. 监听 SillyTavern 事件
    eventSource.on(event_types.CHARACTER_LOADED, handleCharacterChange);
    eventSource.on(event_types.GROUP_LOADED, handleCharacterChange);

    // 监听消息事件 (使用更合适的生成事件)
    eventSource.on('user_message_generating', (chat) => {
        if (!Array.isArray(chat) || chat.length === 0) return;
        const lastMessage = chat[chat.length - 1];
        if (lastMessage && lastMessage.is_user) {
            handleMessage(lastMessage, true);
        }
    });
    eventSource.on('ai_message_generating', (chat) => {
         if (!Array.isArray(chat) || chat.length === 0) return;
         const lastMessage = chat[chat.length - 1];
         if (lastMessage && !lastMessage.is_user) {
             handleMessage(lastMessage, false);
         }
    });

    // 7. 监听窗口焦点
    window.addEventListener('focus', () => {
        if (!isWindowFocused) {
            isWindowFocused = true;
            activeStartTime = Date.now(); // 重新开始计时
            console.log("Window focused, resuming time tracking.");
        }
    });
    window.addEventListener('blur', () => {
        if (isWindowFocused) {
            isWindowFocused = false;
            accumulateTime(); // 累积失去焦点前的最后时间
            syncAccumulatedData(); // 失去焦点时尝试同步
            activeStartTime = null;
            console.log("Window blurred, pausing time tracking and syncing.");
        }
    });

    // 8. 页面卸载前尝试同步 (尽力而为)
    // 使用 'visibilitychange' 可能比 'beforeunload' 更可靠一点点
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            // 用户切换标签页或最小化窗口，类似 blur，也同步一次
            if (isWindowFocused) { // 避免在 blur 后重复触发
                isWindowFocused = false; // 标记为不活跃
                accumulateTime();
                syncAccumulatedData();
                activeStartTime = null;
                 console.log("Window hidden, pausing time tracking and syncing.");
            }
        } else if (document.visibilityState === 'visible') {
             // 用户切回标签页，类似 focus
             if (!isWindowFocused) {
                 isWindowFocused = true;
                 activeStartTime = Date.now();
                 console.log("Window visible, resuming time tracking.");
             }
        }
    });

     // beforeunload 仍然可以作为一个最后的保障
    window.addEventListener('beforeunload', (event) => {
        // 累积最后的时间
        accumulateTime();
        // 尝试同步，但不要期望它一定成功
        // 注意：在 beforeunload 中进行异步操作（如 fetch）通常不可靠
        // 更好的方式是服务器端有更频繁的自动保存（我们已经做了）
        console.log("Attempting final sync before unload...");
        syncAccumulatedData(); // 尝试发送，但可能不会完成

        // 根据规范，不应阻止默认行为
        // delete event['returnValue'];
    });


    console.log("聊天统计插件 (优化版) 加载完成。");
});
