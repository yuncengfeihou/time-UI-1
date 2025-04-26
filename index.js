// SillyTavern 前端插件 - 每日使用统计
jQuery(async () => {
    // 插件基本配置
    const pluginName = 'time-UI-1';
    const pluginId = 'daily-usage-tracker';
    const serverApiBase = `/api/plugins/${pluginId}`;
    const TRACKING_INTERVAL = 15000; // 15秒钟跟踪一次
    
    // 插件状态变量
    let currentEntityId = null;
    let activeStartTime = null;
    let isWindowFocused = true; // 默认窗口获得焦点
    let trackIntervalId = null;
    let entityNameMap = {}; // 实体ID到名称的映射

    if (typeof window.extension_settings === 'undefined') {
        window.extension_settings = {};
    }
    
    // 初始化插件设置
    if (!window.extension_settings[pluginName]) {
        window.extension_settings[pluginName] = {};
        
        // 如果 saveSettingsDebounced 函数存在，则保存设置
        if (typeof window.saveSettingsDebounced === 'function') {
            window.saveSettingsDebounced();
        }
    }

    // 辅助函数 - 获取北京时间日期字符串 (YYYY-MM-DD)
    function getBeijingDateString() {
        return dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD');
    }

    // 辅助函数 - 格式化时长
    function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        return `${hours}小时 ${minutes % 60}分钟 ${seconds % 60}秒`;
    }

    // 辅助函数 - 统计字数
    function countWords(text) {
        if (!text) return 0;
        
        // 简单的字数统计 - 中文按字符计算，英文按空格分词
        // 首先去除所有HTML标签
        const cleanText = text.replace(/<[^>]*>/g, '');
        
        // 英文单词 + 中文/日文/韩文字符
        const wordCount = cleanText.trim().split(/\s+/).filter(word => word.length > 0).length +
                         (cleanText.match(/[\u4e00-\u9fff\u3040-\u30ff\u3130-\u318f\uac00-\ud7af]/g) || []).length;
        
        return wordCount;
    }

    // 辅助函数 - 获取当前实体ID
    function getCurrentEntityId() {
        const context = getContext();
        return context.groupId || context.characterId;
    }

    // API函数 - 发送跟踪数据到服务器
    async function sendTrackingData({ timeMs = 0, msgInc = 0, wordInc = 0, isUser = false } = {}) {
        try {
            // 实时获取当前实体ID
            const entityId = getCurrentEntityId();
            if (!entityId) {
                console.log(`[${pluginName}] 未找到有效的实体ID，跳过数据发送`);
                return;
            }

            // 构建要发送的数据
            const payload = {
                entityId,
                timeIncrementMs: timeMs,
                messageIncrement: msgInc,
                wordIncrement: wordInc,
                isUser
            };

            // 发送数据到服务器
            const response = await fetch(`${serverApiBase}/track`, {
                method: 'POST',
                headers: {
                    ...getRequestHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '未知错误' }));
                console.error(`[${pluginName}] 发送跟踪数据失败:`, errorData.error);
            }
        } catch (error) {
            console.error(`[${pluginName}] 发送跟踪数据异常:`, error);
        }
    }

    // 时间跟踪函数 - 处理并发送时间增量
    function processAndSendTimeIncrement() {
        if (!isWindowFocused || !activeStartTime) return;
        
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        
        const now = Date.now();
        const durationMs = now - activeStartTime;
        
        if (durationMs > 0) {
            sendTrackingData({ timeMs: durationMs });
            // 重置开始时间以准备下一个增量
            activeStartTime = now;
        }
    }

    // 开始跟踪时间间隔
    function startTrackingInterval() {
        // 先停止已有的跟踪
        stopTrackingInterval();
        
        // 获取当前实体ID
        currentEntityId = getCurrentEntityId();
        if (!currentEntityId) {
            console.log(`[${pluginName}] 未找到有效的实体ID，不启动跟踪`);
            return;
        }
        
        // 设置开始时间
        activeStartTime = isWindowFocused ? Date.now() : null;
        
        // 启动定时器
        trackIntervalId = setInterval(processAndSendTimeIncrement, TRACKING_INTERVAL);
        console.log(`[${pluginName}] 已开始跟踪 ${currentEntityId}`);
    }

    // 停止跟踪时间间隔
    function stopTrackingInterval() {
        if (trackIntervalId) {
            clearInterval(trackIntervalId);
            // 处理最后一段时长
            processAndSendTimeIncrement();
            trackIntervalId = null;
        }
        activeStartTime = null;
    }

    // 加载实体名称 - 角色和群组
    function preloadEntityNames() {
        try {
            // 获取角色列表
            const characters = window.characters || [];
            characters.forEach(char => {
                if (char.item && char.item.avatar_url) {
                    entityNameMap[char.item.avatar_url] = char.item.name;
                }
            });
            
            // 获取群组列表
            const groups = window.groups || [];
            groups.forEach(group => {
                if (group.id) {
                    entityNameMap[group.id] = group.name;
                }
            });
            
            console.log(`[${pluginName}] 已加载 ${Object.keys(entityNameMap).length} 个实体名称`);
        } catch (error) {
            console.error(`[${pluginName}] 加载实体名称失败:`, error);
        }
    }

    // 加载并显示统计数据
    async function loadAndDisplayStats(dateString = getBeijingDateString()) {
        try {
            // 显示加载消息
            $('#usage-loading-message').show();
            $('#usage-stats-table').hide();

            // 从服务器获取数据
            const response = await fetch(`${serverApiBase}/stats?date=${dateString}`, {
                headers: getRequestHeaders()
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '未知错误' }));
                throw new Error(errorData.error || `服务器错误 (${response.status})`);
            }

            const statsData = await response.json();
            
            // 检查数据是否为空
            if (Object.keys(statsData).length === 0) {
                $('#usage-loading-message').text(`${dateString} 没有统计数据`);
                return;
            }

            // 预加载实体名称（如果需要）
            if (Object.keys(entityNameMap).length === 0) {
                preloadEntityNames();
            }

            // 清空并填充表格
            const tableBody = $('#usage-stats-table tbody');
            tableBody.empty();
            
            // 格式化并显示数据
            Object.entries(statsData).forEach(([entityId, data]) => {
                const entityName = entityNameMap[entityId] || entityId;
                const totalMessages = data.userMsgCount + data.aiMsgCount;
                const totalWords = data.userWordCount + data.aiWordCount;
                
                const row = $('<tr></tr>');
                row.append(`<td>${entityName}</td>`);
                row.append(`<td>${formatDuration(data.totalTimeMs)}</td>`);
                row.append(`<td>${data.userMsgCount}</td>`);
                row.append(`<td>${data.userWordCount}</td>`);
                row.append(`<td>${data.aiMsgCount}</td>`);
                row.append(`<td>${data.aiWordCount}</td>`);
                row.append(`<td>${totalMessages}</td>`);
                row.append(`<td>${totalWords}</td>`);
                
                tableBody.append(row);
            });
            
            // 显示表格，隐藏加载消息
            $('#usage-loading-message').hide();
            $('#usage-stats-table').show();
            
        } catch (error) {
            console.error(`[${pluginName}] 加载统计数据失败:`, error);
            $('#usage-loading-message').text(`加载失败: ${error.message}`);
        }
    }

    // 事件处理器 - 实体变更
    function handleEntityChange() {
        stopTrackingInterval();
        startTrackingInterval();
    }

    // 事件处理器 - 新消息
    function handleNewMessage(messageId) {
        try {
            const context = getContext();
            // 检查消息ID是否有效
            if (messageId === undefined || messageId === null || !context.chat) {
                return;
            }
            
            // 获取消息内容
            const message = context.chat[messageId];
            if (!message) return;
            
            // 获取当前实体ID
            const entityId = getCurrentEntityId();
            if (!entityId) return;
            
            // 统计字数
            const wordCount = countWords(message.mes);
            
            // 确定消息来源
            const isUser = message.is_user === true;
            
            // 发送数据到服务器
            sendTrackingData({
                msgInc: 1,
                wordInc: wordCount,
                isUser: isUser
            });
            
            // 如果窗口有焦点，重置活跃开始时间（提高跟踪精度）
            if (isWindowFocused) {
                activeStartTime = Date.now();
            }
        } catch (error) {
            console.error(`[${pluginName}] 处理新消息失败:`, error);
        }
    }

    // 渲染并注入UI
    try {
        // 加载HTML模板
        const htmlTemplate = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'ui');
        
        // 将模板注入到扩展页面
        $('#translation_container').append(htmlTemplate);
        
        // 预加载实体名称
        preloadEntityNames();
        
        // 设置日期选择器默认值为今天（北京时间）
        const today = getBeijingDateString();
        $('#usage-datepicker').val(today);
        
        // 初始加载今天的数据
        loadAndDisplayStats(today);
        
        // 绑定日期选择器变更事件
        $('#usage-datepicker').on('change', function() {
            const selectedDate = $(this).val();
            loadAndDisplayStats(selectedDate);
        });
        
        // 绑定刷新按钮点击事件
        $('#usage-refresh-button').on('click', function() {
            const selectedDate = $('#usage-datepicker').val();
            loadAndDisplayStats(selectedDate);
        });
        
        console.log(`[${pluginName}] UI初始化完成`);
    } catch (error) {
        console.error(`[${pluginName}] 渲染UI模板失败:`, error);
    }

    // 添加事件监听
    // 角色/群组切换事件
    eventSource.on(event_types.CHARACTER_LOADED, handleEntityChange);
    eventSource.on(event_types.GROUP_LOADED, handleEntityChange);
    eventSource.on(event_types.CHAT_CHANGED, handleEntityChange);
    
    // 消息事件
    eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
    
    // 窗口焦点事件
    $(window).on('focus', function() {
        isWindowFocused = true;
        activeStartTime = Date.now();
    });
    
    $(window).on('blur', function() {
        isWindowFocused = false;
        processAndSendTimeIncrement();
        activeStartTime = null;
    });
    
    // 页面卸载前事件 - 尽力而为，不一定能捕获所有情况
    $(window).on('beforeunload', function() {
        stopTrackingInterval();
    });
    
    // 初始化跟踪
    handleEntityChange();
    
    console.log(`[${pluginName}] 插件初始化完成`);
});
