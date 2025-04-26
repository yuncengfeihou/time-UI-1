// SillyTavern 前端插件 - 每日使用统计 (基础兼容版)
jQuery(async () => {
    // 插件基本配置
    const pluginName = 'time-UI-1';
    const pluginId = 'daily-usage-tracker';
    const serverApiBase = `/api/plugins/${pluginId}`;
    const TRACKING_INTERVAL = 15000; // 15秒钟跟踪一次
    
    // 插件状态变量
    let currentEntityId = null;        // 当前聊天的角色/群组ID
    let activeStartTime = null;        // 活跃时间开始点
    let isWindowFocused = true;        // 窗口焦点状态
    let trackIntervalId = null;        // 跟踪定时器ID
    let entityNameMap = {};            // 实体ID到名称的映射
    
    console.log(`[${pluginName}] 插件开始初始化`);

    // 辅助函数 - 获取北京时间日期字符串 (YYYY-MM-DD)
    function getBeijingDateString() {
        // 使用本地时间，假设用户设置了正确的时区
        // 在实际环境中，可能需要更精确的处理
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
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
        
        // 简单的字数统计
        const cleanText = text.replace(/<[^>]*>/g, '');
        
        // 英文单词 + 中文/日文/韩文字符
        const wordCount = cleanText.trim().split(/\s+/).filter(word => word.length > 0).length +
                         (cleanText.match(/[\u4e00-\u9fff\u3040-\u30ff\u3130-\u318f\uac00-\ud7af]/g) || []).length;
        
        return wordCount;
    }

    // 尝试从URL获取当前实体ID (基础逻辑，可能需要根据SillyTavern版本调整)
    function getCurrentEntityId() {
        try {
            // 尝试从URL或DOM中获取当前角色/群组ID
            // 这是一个简单的示例实现，实际情况可能更复杂
            const path = window.location.pathname;
            const parts = path.split('/');
            const lastPart = parts[parts.length - 1];
            
            if (lastPart && lastPart !== '') {
                return lastPart;
            }
            
            // 如果无法从URL获取，返回一个默认值或null
            return 'unknown_entity';
        } catch (error) {
            console.error(`[${pluginName}] 获取实体ID失败:`, error);
            return 'unknown_entity';
        }
    }

    // API函数 - 发送跟踪数据到服务器
    async function sendTrackingData({ timeMs = 0, msgInc = 0, wordInc = 0, isUser = false } = {}) {
        try {
            // 获取实体ID
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
                    'Content-Type': 'application/json'
                    // 注：移除了依赖getRequestHeaders的部分
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

    // 基本名称加载 - 以后可以扩展
    function preloadEntityNames() {
        // 简化版本，实际实现可能需要更复杂的逻辑
        console.log(`[${pluginName}] 尝试加载实体名称`);
    }

    // 加载并显示统计数据
    async function loadAndDisplayStats(dateString = getBeijingDateString()) {
        try {
            // 显示加载消息
            $('#usage-loading-message').show();
            $('#usage-stats-table').hide();

            // 从服务器获取数据
            const response = await fetch(`${serverApiBase}/stats?date=${dateString}`, {
                method: 'GET'
                // 注：移除了依赖getRequestHeaders的部分
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

    // 事件处理器 - 基本的变更处理
    function handleEntityChange() {
        stopTrackingInterval();
        startTrackingInterval();
    }

    // 尝试监控消息变化的基础实现
    function setupBasicMessageMonitoring() {
        // 由于无法依赖SillyTavern API，我们使用基本的DOM观察
        console.log(`[${pluginName}] 设置基本消息监控`);
        
        // 定期检查DOM变化
        setInterval(() => {
            // 这里可以实现基本的DOM监控逻辑
            // 注意：这只是一个简单占位，实际实现可能需要更复杂的逻辑
        }, 5000); // 每5秒检查一次
    }

    // 渲染并注入UI
    try {
        // 直接使用HTML字符串
        const htmlTemplate = `
        <div id="daily-usage-plugin-container" class="daily-usage-container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>每日使用统计</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="daily-usage-header">
                        <div>
                            <label for="usage-datepicker">选择日期:</label>
                            <input type="date" id="usage-datepicker" class="text_pole">
                        </div>
                        <button id="usage-refresh-button" class="menu_button fa-solid fa-arrows-rotate" title="刷新"></button>
                    </div>
                    <div id="usage-display-area" class="daily-usage-display">
                        <p id="usage-loading-message">正在加载数据...</p>
                        <table id="usage-stats-table" class="daily-usage-table" style="display: none;">
                            <thead>
                                <tr>
                                    <th>角色/群组</th>
                                    <th>活跃时长</th>
                                    <th>你的消息</th>
                                    <th>你的字数</th>
                                    <th>AI 消息</th>
                                    <th>AI 字数</th>
                                    <th>总消息</th>
                                    <th>总字数</th>
                                </tr>
                            </thead>
                            <tbody>
                                <!-- 数据行将动态插入 -->
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>`;
        
        // 尝试将HTML注入到几个可能的容器
        const possibleContainers = [
            '#translation_container', 
            '#extensions_settings',
            '#extensions-settings-block',
            'body' // 最后的备选项
        ];
        
        let injected = false;
        for (const container of possibleContainers) {
            if ($(container).length > 0) {
                $(container).append(htmlTemplate);
                console.log(`[${pluginName}] UI已注入到 ${container}`);
                injected = true;
                break;
            }
        }
        
        if (!injected) {
            console.error(`[${pluginName}] 无法找到任何有效的UI容器来注入插件`);
        }
        
        // 设置日期选择器默认值为今天
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
        console.error(`[${pluginName}] 渲染UI失败:`, error);
    }

    // 使用基本的window事件
    $(window).on('focus', function() {
        isWindowFocused = true;
        activeStartTime = Date.now();
        console.log(`[${pluginName}] 窗口获得焦点`);
    });
    
    $(window).on('blur', function() {
        isWindowFocused = false;
        processAndSendTimeIncrement();
        activeStartTime = null;
        console.log(`[${pluginName}] 窗口失去焦点`);
    });
    
    // 页面卸载前事件
    $(window).on('beforeunload', function() {
        stopTrackingInterval();
    });
    
    // 尝试监控URL变化（简单方法检测角色切换）
    let lastUrl = window.location.href;
    setInterval(() => {
        if (lastUrl !== window.location.href) {
            lastUrl = window.location.href;
            console.log(`[${pluginName}] 检测到URL变化，可能是角色切换`);
            handleEntityChange();
        }
    }, 2000); // 每2秒检查一次
    
    // 设置基本消息监控
    setupBasicMessageMonitoring();
    
    // 初始化跟踪
    handleEntityChange();
    
    // 添加一些CSS样式
    $('head').append(`
    <style>
        .daily-usage-container {
            margin-top: 10px;
        }
        
        .daily-usage-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        
        .daily-usage-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        
        .daily-usage-table th, 
        .daily-usage-table td {
            border: 1px solid #444;
            padding: 6px 8px;
            text-align: left;
            font-size: 0.9em;
        }
        
        .daily-usage-table th {
            background-color: #333;
        }
        
        .daily-usage-display {
            max-height: 300px;
            overflow-y: auto;
            margin-top: 10px;
        }
    </style>
    `);
    
    console.log(`[${pluginName}] 插件初始化完成`);
});
