// SillyTavern/public/extensions/third-party/time-UI-1/index.js

// 确保在 jQuery(async () => { ... }); 之外导入，因为这些是全局可用的
// 导入 SillyTavern 核心功能
import {
    saveSettingsDebounced, // 虽然此插件不直接保存设置，但导入以备将来扩展
    eventSource,
    // 注意：文档中是 event_types，但为了兼容旧代码或可能存在的风格，有时也用 event_types
    // 检查你的 SillyTavern 版本或 context.eventTypes 来确认
    // 此处我们假设 event_types 是正确的
    event_types,
    messageFormatting, // 消息格式化 (此插件不需要)
    getRequestHeaders, // **非常重要** 用于获取 API 请求头 (CSRF token)
    getCharacters, // 获取角色列表
} from '../../../../script.js'; // 路径相对于 public/index.html

// 导入扩展助手
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings, // 全局插件设置对象 (此插件主要用于读取 entity 名称，不写入)
} from '../../../extensions.js';

// 导入扩展助手
import {
        getGroups, // 获取群组列表
} from '../../../group-chats.js';

// 导入工具函数 (可选，如有需要)
import {
    uuidv4, // 生成 UUID
    timestampToMoment, // 时间戳转 Moment 对象 (需要 moment.js)
    // 注意：Day.js 可能需要单独引入或确认 ST 是否全局提供
    // 此处我们假设 Day.js 已通过 script 标签或其他方式全局可用，或通过服务器插件安装后，浏览器可访问其部分功能
    // 如果没有全局 Day.js，需要自行处理北京时间获取或使用原生 Date
} from '../../../utils.js';

// --- 常量与配置 ---
const pluginName = 'time-UI-1'; // 与文件夹名称匹配
const pluginId = 'daily-usage-tracker'; // 与服务器插件 ID 匹配
const serverApiBase = `/api/plugins/${pluginId}`; // 后端 API 基础路径
const TRACKING_INTERVAL_MS = 15 * 1000; // 每 15 秒发送一次时间增量
const PLUGIN_FOLDER_PATH = `third-party/${pluginName}`; // HTML 模板路径
const TARGET_CONTAINER = '#extensions_settings'; // 尝试注入的目标容器 (如果 #translation_container 不存在或不合适)
// const TARGET_CONTAINER = '#translation_container'; // 另一个可能的注入目标容器

// --- 状态变量 ---
let currentEntityId = null; // 当前互动的角色或群组 ID
let activeStartTime = null; // 窗口/标签页聚焦开始时间戳
let isWindowFocused = document.hasFocus(); // 初始窗口焦点状态
let trackIntervalId = null; // 时间跟踪定时器 ID
let entityNameMap = {}; // 缓存实体 ID 到名称的映射 { 'entityId': 'Entity Name' }
let isLoadingStats = false; // 防止重复加载统计数据

// --- jQuery 入口点 ---
jQuery(async () => {
    console.log(`[${pluginName}] Plugin loading...`);

    // --- 辅助函数 ---

    /**
     * 获取当前北京时间的日期字符串 (YYYY-MM-DD) - 客户端实现
     * 注意: 这依赖于客户端系统时间设置可能不完全准确，但用于默认日期选择器足够。
     * 最准确的日期判断在服务器端完成。
     * @returns {string}
     */
    function getBeijingDateStringClient() {
        // 尝试使用 Day.js (如果全局可用)
        if (typeof dayjs === 'function' && typeof dayjs.tz === 'function') {
            try {
                return dayjs().tz("Asia/Shanghai").format('YYYY-MM-DD');
            } catch (e) {
                console.warn(`[${pluginName}] Day.js timezone function failed, falling back to Date object.`, e);
            }
        }
        // Fallback using native Date (less accurate for timezone conversion)
        const now = new Date();
        const beijingOffset = 8 * 60; // Beijing is UTC+8
        const localOffset = -now.getTimezoneOffset();
        const utcTimestamp = now.getTime() + (localOffset * 60 * 1000);
        const beijingTimestamp = utcTimestamp + (beijingOffset * 60 * 1000);
        const beijingDate = new Date(beijingTimestamp);
        const year = beijingDate.getUTCFullYear();
        const month = String(beijingDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(beijingDate.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }


    /**
     * 格式化毫秒时长为易读字符串 (例如: 1h 2m 30s)
     * @param {number} ms 毫秒数
     * @returns {string}
     */
    function formatDuration(ms) {
        if (ms < 0) ms = 0;
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        const s = seconds % 60;
        const m = minutes % 60;
        const h = hours;

        let result = '';
        if (h > 0) result += `${h}h `;
        if (m > 0) result += `${m}m `;
        // 总是显示秒，即使是 0，除非总时长为 0
        if (h > 0 || m > 0 || s > 0 || ms === 0) {
             result += `${s}s`;
        }
         // 如果结果为空字符串（意味着时长极小但大于0ms），显示 "<1s"
        if (result === '' && ms > 0) {
            result = '<1s';
        } else if (result === '') {
            result = '0s'; // 明确显示 0s
        }

        return result.trim();
    }

    /**
     * 简单地统计单词数 (按空格分割)
     * @param {string} text
     * @returns {number}
     */
    function countWords(text) {
        if (!text || typeof text !== 'string') return 0;
        return text.trim().split(/\s+/).filter(Boolean).length; // 按空格分割并过滤空字符串
    }

    /**
     * 获取当前正在聊天的实体 (角色或群组) ID
     * @returns {string|null}
     */
    function getCurrentEntityId() {
        const context = getContext();
        // 群组优先，因为群组聊天中 characterId 可能是群组成员之一
        return context.groupId || context.characterId || null;
    }

    /**
     * 向后端发送跟踪数据 (时间增量 或 消息增量)
     * @param {object} data
     * @param {number} [data.timeMs] 时间增量 (毫秒)
     * @param {number} [data.msgInc] 消息增量 (通常是 1)
     * @param {number} [data.wordInc] 字数增量
     * @param {boolean} [data.isUser] 是否是用户消息 (当 msgInc > 0 时必需)
     */
    async function sendTrackingData({ timeMs, msgInc, wordInc, isUser }) {
        const entityId = getCurrentEntityId(); // **在发送时实时获取**
        if (!entityId) {
            // console.warn(`[${pluginName}] Attempted to send tracking data but no active entity.`);
            return; // 没有活动实体，不发送
        }

        const payload = { entityId };
        if (typeof timeMs === 'number' && timeMs > 0) {
            payload.timeIncrementMs = Math.round(timeMs); // 取整
        }
        if (typeof msgInc === 'number' && msgInc > 0) {
            payload.messageIncrement = msgInc;
            payload.wordIncrement = typeof wordInc === 'number' ? wordInc : 0;
            if (typeof isUser !== 'boolean') {
                console.error(`[${pluginName}] 'isUser' is required when sending message increment.`);
                return; // isUser 是必需的
            }
            payload.isUser = isUser;
        }

        // 如果没有任何有效增量，则不发送
        if (!payload.timeIncrementMs && !payload.messageIncrement) {
            return;
        }

        try {
             // console.log(`[${pluginName}] Sending tracking data:`, payload);
            const response = await fetch(`${serverApiBase}/track`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getRequestHeaders(), // **添加 CSRF Token 等必要头信息**
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `HTTP error ${response.status}` }));
                console.error(`[${pluginName}] Error sending tracking data: ${response.status}`, errorData.error || response.statusText);
            }
        } catch (error) {
            console.error(`[${pluginName}] Network or fetch error sending tracking data:`, error);
        }
    }

     /**
     * 设置状态信息
     * @param {string} text 状态文本
     * @param {'loading' | 'error' | 'success' | 'idle'} type 状态类型
     */
    function setStatus(text, type = 'idle') {
        const statusEl = $('#usage-status');
        statusEl.text(text);
        statusEl.removeClass('loading error success idle').addClass(type);
    }

    /**
     * 加载并显示指定日期的统计数据
     * @param {string} dateString YYYY-MM-DD
     */
    async function loadAndDisplayStats(dateString) {
        if (isLoadingStats) return; // 防止并发加载
        isLoadingStats = true;
        setStatus('加载中...', 'loading');
        $('#usage-stats-table tbody').empty(); // 清空旧数据
        $('#usage-stats-table').hide();
        $('#usage-no-data').hide();
         // 重置总计行
        $('#usage-totals-row td[data-col]').text('-');


        try {
            // 确保实体名称已加载
            await preloadEntityNames();

            const response = await fetch(`${serverApiBase}/stats?date=${dateString}`, {
                method: 'GET',
                headers: getRequestHeaders(), // 添加 CSRF Token 等
            });

            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}`);
            }

            const statsData = await response.json();
             // console.log(`[${pluginName}] Received stats for ${dateString}:`, statsData);

            const $tbody = $('#usage-stats-table tbody');
            const $totalsRow = $('#usage-totals-row');
            let totals = { time: 0, userMsg: 0, userWords: 0, aiMsg: 0, aiWords: 0, totalMsg: 0, totalWords: 0 };


            if (Object.keys(statsData).length === 0) {
                $('#usage-no-data').show();
                setStatus(''); // 清除加载状态
            } else {
                // 按总时长降序排序实体 ID
                const sortedEntityIds = Object.keys(statsData).sort((a, b) => {
                    const timeA = statsData[a]?.totalTimeMs || 0;
                    const timeB = statsData[b]?.totalTimeMs || 0;
                    return timeB - timeA;
                });


                for (const entityId of sortedEntityIds) {
                    const stats = statsData[entityId];
                    if (!stats) continue;

                    const entityName = entityNameMap[entityId] || `未知实体 (${entityId.substring(0, 6)}...)`; // 使用缓存的名称，否则显示部分 ID
                    const totalMsg = (stats.userMsgCount || 0) + (stats.aiMsgCount || 0);
                    const totalWords = (stats.userWordCount || 0) + (stats.aiWordCount || 0);

                    // 累加总计
                    totals.time += stats.totalTimeMs || 0;
                    totals.userMsg += stats.userMsgCount || 0;
                    totals.userWords += stats.userWordCount || 0;
                    totals.aiMsg += stats.aiMsgCount || 0;
                    totals.aiWords += stats.aiWordCount || 0;
                    totals.totalMsg += totalMsg;
                    totals.totalWords += totalWords;

                    const $row = $('<tr>').append(
                        $('<td>').text(entityName),
                        $('<td>').text(formatDuration(stats.totalTimeMs || 0)),
                        $('<td>').text(stats.userMsgCount || 0),
                        $('<td>').text(stats.userWordCount || 0),
                        $('<td>').text(stats.aiMsgCount || 0),
                        $('<td>').text(stats.aiWordCount || 0),
                         $('<td>').text(totalMsg),
                        $('<td>').text(totalWords)
                    );
                    $tbody.append($row);
                }

                 // 更新总计行
                $totalsRow.find('td[data-col="time"]').text(formatDuration(totals.time));
                $totalsRow.find('td[data-col="userMsg"]').text(totals.userMsg);
                $totalsRow.find('td[data-col="userWords"]').text(totals.userWords);
                $totalsRow.find('td[data-col="aiMsg"]').text(totals.aiMsg);
                $totalsRow.find('td[data-col="aiWords"]').text(totals.aiWords);
                $totalsRow.find('td[data-col="totalMsg"]').text(totals.totalMsg);
                $totalsRow.find('td[data-col="totalWords"]').text(totals.totalWords);


                $('#usage-stats-table').show();
                 setStatus(''); // 清除加载状态
            }

        } catch (error) {
            console.error(`[${pluginName}] Error loading or displaying stats for ${dateString}:`, error);
             setStatus(`加载失败: ${error.message}`, 'error');
            $('#usage-no-data').text('加载统计数据时出错。').show();
        } finally {
            isLoadingStats = false;
        }
    }

    /**
     * 预加载角色和群组名称到 entityNameMap
     * 尝试多种方式获取列表，提高兼容性
     */
    async function preloadEntityNames() {
         entityNameMap = {}; // 重置映射
         try {
            const context = getContext(); // 获取当前上下文

            // 方式一：尝试使用 getCharacters/getGroups (如果 ST 提供且可用)
            if (typeof getCharacters === 'function') {
                const characters = await getCharacters(); // 假设它返回 [{id: ..., name: ...}, ...]
                 if (Array.isArray(characters)) {
                     characters.forEach(char => { if (char.id && char.name) entityNameMap[char.id] = char.name; });
                 }
            } else if (Array.isArray(context.characters)) {
                 // 方式二：直接从 context 读取 (如果列表存在)
                 context.characters.forEach(char => { if (char.id && char.name) entityNameMap[char.id] = char.name; });
            }

            if (typeof getGroups === 'function') {
                const groups = await getGroups(); // 假设它返回 [{id: ..., name: ...}, ...]
                 if (Array.isArray(groups)) {
                    groups.forEach(group => { if (group.id && group.name) entityNameMap[group.id] = group.name; });
                 }
            } else if (Array.isArray(context.groups)) {
                 // 方式二：直接从 context 读取
                context.groups.forEach(group => { if (group.id && group.name) entityNameMap[group.id] = group.name; });
            }
             // console.log(`[${pluginName}] Entity names preloaded:`, entityNameMap);

         } catch (error) {
             console.error(`[${pluginName}] Error preloading entity names:`, error);
         }
    }

    // --- 时间跟踪逻辑 ---

    /**
     * 处理并发送自上次调用以来的时间增量
     */
    function processAndSendTimeIncrement() {
        // 必须窗口聚焦、有开始时间、有活动实体才计算
        if (isWindowFocused && activeStartTime && currentEntityId) {
            const now = Date.now();
            const durationMs = now - activeStartTime;
            if (durationMs > 100) { // 只有当持续时间大于 100ms 才发送，避免过于频繁的无效请求
                sendTrackingData({ timeMs: durationMs });
                // **关键：发送后重置开始时间为当前时间**
                activeStartTime = now;
            } else {
                 // 如果时长太短，不发送，但仍需更新开始时间，否则下次计算会包含这段短时间
                activeStartTime = now;
            }
        } else {
             // 如果窗口未聚焦或没有实体，清除开始时间
            activeStartTime = null;
        }
    }

    /**
     * 启动时间跟踪定时器
     */
    function startTrackingInterval() {
        stopTrackingInterval(); // 先确保旧的定时器已停止

        currentEntityId = getCurrentEntityId(); // 获取当前实体 ID
        if (!currentEntityId) return; // 没有实体，不启动

        // 如果窗口是聚焦的，记录当前时间为开始时间
        if (isWindowFocused) {
            activeStartTime = Date.now();
        } else {
             activeStartTime = null; // 否则无开始时间
        }

        // 启动定时器，定期处理时间增量
        trackIntervalId = setInterval(processAndSendTimeIncrement, TRACKING_INTERVAL_MS);
        // console.log(`[${pluginName}] Tracking interval started for entity: ${currentEntityId}`);
    }

    /**
     * 停止时间跟踪定时器，并在停止前处理最后一次时间增量
     */
    function stopTrackingInterval() {
        if (trackIntervalId) {
            clearInterval(trackIntervalId);
            trackIntervalId = null;
            // **关键：停止时，处理并发送最后剩余的时间段**
            processAndSendTimeIncrement();
            // console.log(`[${pluginName}] Tracking interval stopped. Final increment sent.`);
        }
         // 重置状态
         activeStartTime = null;
        // currentEntityId 不在此处重置，由 entityChange 处理
    }


    // --- 事件处理 ---

    /**
     * 处理角色或群组切换
     */
    function handleEntityChange() {
         // console.log(`[${pluginName}] Entity changed.`);
        // 先停止当前实体的计时（会发送最后的时间增量）
        stopTrackingInterval();
        // 为新实体（如果有）启动新的计时
        startTrackingInterval();
    }

     /**
     * 处理新消息（发送或接收）
     * @param {object} eventData - 事件附带的数据，通常包含 messageId
     */
    function handleNewMessage(eventData) {
        // eventData 可能因事件类型而异，需要健壮处理
        const messageId = eventData?.messageId || eventData?.id; // 尝试获取 messageId
        if (messageId == null) return; // 没有 ID 无法处理

        try {
            const context = getContext();
            // 注意：SillyTavern 的 chat 数组可能是稀疏的或 ID 不连续，直接用 messageId 索引可能失败
            // 最好是从后往前查找匹配 ID 的消息，或者确保 context.chat[messageId] 可靠
             // 假设 messageId 是数组索引或可以映射到索引
            const chatLogEntry = Array.isArray(context.chat) ? context.chat.find(msg => msg.id === messageId) : null; // 更可靠的查找方式

            if (!chatLogEntry) {
                console.warn(`[${pluginName}] Could not find message with ID ${messageId} in context.chat.`);
                return;
            }

            const entityId = getCurrentEntityId();
            if (!entityId) return; // 无法确定消息属于哪个实体

            const wordCount = countWords(chatLogEntry.mes || '');
            const isUser = chatLogEntry.is_user === true;

             // console.log(`[${pluginName}] New message detected (id: ${messageId}, user: ${isUser}, words: ${wordCount})`);

            // 发送消息增量数据
            sendTrackingData({ msgInc: 1, wordInc: wordCount, isUser: isUser });

            // (可选) 收到消息后，可以认为用户活跃，重置活跃计时起点，提高时间精度
            if (isWindowFocused) {
                 activeStartTime = Date.now();
            }

        } catch (error) {
            console.error(`[${pluginName}] Error handling new message (ID: ${messageId}):`, error);
        }
    }

    // --- 初始化流程 ---

    console.log(`[${pluginName}] Starting initialization...`);

    // 1. 加载并注入 HTML UI
    try {
        const settingsHtml = await renderExtensionTemplateAsync(PLUGIN_FOLDER_PATH, 'ui');
        // 尝试注入到首选容器，如果失败则尝试备用容器
        if ($(TARGET_CONTAINER).length) {
             $(TARGET_CONTAINER).append(settingsHtml);
             console.log(`[${pluginName}] UI injected into ${TARGET_CONTAINER}`);
        } else if ($('#extensions_settings').length) {
             // 备用容器，如果 TARGET_CONTAINER 不可用
             console.warn(`[${pluginName}] Target container '${TARGET_CONTAINER}' not found, attempting to inject into '#extensions_settings'.`);
             $('#extensions_settings').append(settingsHtml);
             console.log(`[${pluginName}] UI injected into #extensions_settings`);
        }
         else {
             console.error(`[${pluginName}] Could not find a suitable container ('${TARGET_CONTAINER}' or '#extensions_settings') to inject UI.`);
             // 可能需要在此处停止插件初始化或显示错误给用户
             return;
         }

    } catch (error) {
        console.error(`[${pluginName}] Failed to load or inject UI template:`, error);
        return; // 无法加载 UI，停止初始化
    }

    // 2. 预加载实体名称 (异步，不阻塞后续步骤)
     preloadEntityNames(); // 先调用一次，后续在需要时再调用

    // 3. 设置日期选择器默认值并加载当天数据
    const todayBeijing = getBeijingDateStringClient();
    $('#usage-datepicker').val(todayBeijing);
    loadAndDisplayStats(todayBeijing); // 初始加载当天数据

    // 4. 绑定 UI 事件监听器
    $('#usage-datepicker').on('change', function() {
        const selectedDate = $(this).val();
        if (selectedDate) {
            loadAndDisplayStats(selectedDate);
        }
    });
    $('#usage-refresh-button').on('click', () => {
        const selectedDate = $('#usage-datepicker').val() || getBeijingDateStringClient();
        loadAndDisplayStats(selectedDate);
    });

    // 5. 监听 SillyTavern 前端事件
    // CHAT_CHANGED 通常在切换角色、群组、加载新聊天时触发，是比较好的监听点
    eventSource.on(event_types.CHAT_CHANGED, handleEntityChange);
    // 监听消息发送和接收事件 (更精确)
    eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
    // 当角色/群组数据本身发生变化时（例如重命名），重新加载名称映射
    eventSource.on(event_types.CHARACTER_EDITED, preloadEntityNames);
    eventSource.on(event_types.GROUP_UPDATED, preloadEntityNames);


    // 6. 监听浏览器窗口/标签页的焦点事件
    $(window).on('focus', () => {
        if (!isWindowFocused) {
            // console.log(`[${pluginName}] Window focused.`);
            isWindowFocused = true;
            // 如果当前有实体在跟踪，记录新的开始时间
            if (currentEntityId) {
                 activeStartTime = Date.now();
            }
        }
    });
    $(window).on('blur', () => {
        if (isWindowFocused) {
            // console.log(`[${pluginName}] Window lost focus.`);
            isWindowFocused = false;
            // 窗口失焦时，处理并发送当前累计的时间
            processAndSendTimeIncrement();
            // 清除开始时间，因为不再聚焦
            activeStartTime = null;
        }
    });

    // 7. 监听页面卸载事件 (尽力而为，不保证一定执行)
    $(window).on('beforeunload', () => {
        // 在页面关闭前，尝试停止计时并发送最后的数据
        // 注意：这个事件中的异步操作（如 fetch）可能不会完成
        stopTrackingInterval();
        // 可以在这里尝试发送一个同步请求 (navigator.sendBeacon)，但后端需要支持
    });

    // 8. 获取初始实体状态并开始跟踪
    handleEntityChange(); // 调用一次以获取初始状态并启动计时器

    console.log(`[${pluginName}] Plugin initialized successfully.`);

}); // --- End of jQuery(async () => { ... }); ---
