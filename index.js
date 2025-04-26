// Import necessary functions from SillyTavern scripts
// Adjust paths based on your SillyTavern version if needed
import {
    saveSettingsDebounced, // Although not used directly for stats, good practice to import if needed
    getCurrentChatId,      // May not be needed if getContext provides enough
    eventSource,
    // event_types, // Use the camelCase version below
    messageFormatting,     // Not used here, but example import
    getRequestHeaders,     // CRUCIAL for API calls
    getContext,            // CRUCIAL for getting context
} from '../../../../script.js'; // Path relative to this file

import {
    renderExtensionTemplateAsync,
    extension_settings,       // Use for UI settings if any, not core stats
} from '../../../extensions.js'; // Path relative to this file

import {
    Popup,                 // For potential future popups
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';     // Path relative to this file

import {
    uuidv4,                // If needed for unique IDs
    timestampToMoment,     // For date/time display formatting
    // Add other utils if needed
} from '../../../utils.js';      // Path relative to this file

// Use the modern 'eventTypes' from getContext() if available, otherwise fall back
const eventTypes = window.SillyTavern.getContext?.().eventTypes ?? window.event_types;

// Polyfill for dayjs if not globally available (basic YYYY-MM-DD)
const getClientBeijingDateString = () => {
    try {
        // Attempt to use globally available dayjs if ST provides it
        if (window.dayjs && window.dayjs.tz) {
             return window.dayjs().tz("Asia/Shanghai").format('YYYY-MM-DD');
        }
    } catch (e) {
       console.warn('[DailyUsageTrackerUI] Failed to use global dayjs. Falling back to basic Date object.');
    }
    // Fallback using basic Date object (less reliable for timezones but works for date part)
    const now = new Date();
    const offset = 8 * 60; // Beijing is UTC+8
    const beijingTime = new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60000);
    const year = beijingTime.getFullYear();
    const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};


jQuery(async () => {
    const pluginName = 'time-UI-1'; // For logging
    const pluginId = 'daily-usage-tracker';   // MUST match server plugin ID
    const serverApiBase = `/api/plugins/${pluginId}`;
    const TRACKING_INTERVAL_MS = 15 * 1000; // Send time update every 15 seconds

    console.log(`[${pluginName}] Initializing...`);

    // --- State Variables ---
    let currentEntityId = null; // characterId or groupId
    let activeStartTime = null; // Timestamp when focus gained / entity changed while focused
    let isWindowFocused = document.hasFocus(); // Initial focus state
    let trackIntervalId = null; // ID for the setInterval timer
    let entityNameMap = {}; // Cache for { id: name }

    // --- Helper Functions ---

    /** Simple word count (adjust regex as needed for different languages) */
    function countWords(text) {
        if (!text || typeof text !== 'string') return 0;
        // Basic word count: split by spaces and common punctuation, filter empty strings.
        // Consider more sophisticated tokenization for CJK languages if needed.
        const words = text.match(/\b(\w+)\b/g); // Matches sequences of word characters
        return words ? words.length : 0;
    }

    /** Format milliseconds to HH:MM:SS or MM:SS */
    function formatDuration(ms) {
        if (typeof ms !== 'number' || ms < 0) return '00:00';
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const paddedMinutes = String(minutes).padStart(2, '0');
        const paddedSeconds = String(seconds).padStart(2, '0');

        if (hours > 0) {
            const paddedHours = String(hours).padStart(2, '0');
            return `${paddedHours}:${paddedMinutes}:${paddedSeconds}`;
        } else {
            return `${paddedMinutes}:${paddedSeconds}`;
        }
    }

    /** Get current character or group ID from context */
    function getCurrentContextEntityId() {
        try {
            const context = getContext();
            // Prefer group ID if it exists (indicates a group chat)
            return context?.groupId || context?.characterId || null;
        } catch (error) {
             console.error(`[${pluginName}] Error getting context:`, error);
             return null;
        }
    }

     /** Preload character and group names for display */
    async function preloadEntityNames() {
        entityNameMap = {}; // Reset map
        try {
            const context = getContext();
            // Access characters and groups directly from context (modern ST)
            const characters = context?.characters ?? [];
            const groups = context?.groups ?? [];

             characters.forEach(char => {
                if (char.id !== undefined && char.name) { // Use 'id' if available, fallback to index? (check ST structure)
                   entityNameMap[char.id ?? characters.indexOf(char)] = char.name;
                } else if (char.name && char.file_name) { // Fallback using file_name based index? Needs verification
                    const charIndex = characters.findIndex(c => c.file_name === char.file_name);
                     if(charIndex !== -1) entityNameMap[charIndex] = char.name;
                }
             });

             groups.forEach(group => {
                if (group.id && group.name) {
                    entityNameMap[group.id] = group.name;
                }
             });
             console.debug(`[${pluginName}] Preloaded ${Object.keys(entityNameMap).length} entity names.`);
        } catch (error) {
            console.error(`[${pluginName}] Error preloading entity names:`, error);
            // Try to get names from older global variables if context fails? (Less likely needed now)
            // if (window.characters && Array.isArray(window.characters)) { ... }
            // if (window.groups && Array.isArray(window.groups)) { ... }
        }
    }


    /** Get entity name from cache, fallback to ID */
    function getEntityName(id) {
        return entityNameMap[id] || `ID: ${id}` || '未知实体';
    }

    // --- API Communication ---

    /** Send tracking data increment to the backend */
    async function sendTrackingData({ timeMs, msgInc, wordInc, isUser }) {
        const entityId = getCurrentContextEntityId();
        if (!entityId) {
            // console.warn(`[${pluginName}] Cannot send tracking data: No active entityId.`);
            return; // Don't send if no character/group is active
        }

        const payload = { entityId };
        let hasData = false;

        if (typeof timeMs === 'number' && timeMs > 0) {
            payload.timeIncrementMs = Math.round(timeMs); // Send integer ms
            hasData = true;
        }
        if (typeof msgInc === 'number' && msgInc > 0) {
            payload.messageIncrement = msgInc;
            payload.wordIncrement = typeof wordInc === 'number' ? wordInc : 0;
            payload.isUser = !!isUser; // Ensure boolean
            hasData = true;
        }

        if (!hasData) return; // Don't send empty requests

        // console.debug(`[${pluginName}] Sending tracking data:`, payload); // Debug log

        try {
            const response = await fetch(`${serverApiBase}/track`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...getRequestHeaders(), // Include necessary ST headers (CSRF etc.)
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `HTTP Error: ${response.status}` }));
                console.error(`[${pluginName}] Failed to send tracking data: ${response.status}`, errorData.error || '');
            }
        } catch (error) {
            console.error(`[${pluginName}] Network error sending tracking data:`, error);
        }
    }

    /** Load stats for a specific date and update the display table */
    async function loadAndDisplayStats(dateString) {
        const $loadingMessage = $('#usage-loading-message');
        const $statsTable = $('#usage-stats-table');
        const $statsTableBody = $statsTable.find('tbody');

        $loadingMessage.text('正在加载...').show();
        $statsTable.hide();
        $statsTableBody.empty(); // Clear previous data

        try {
            // Ensure names are loaded before displaying stats
            await preloadEntityNames();

            const response = await fetch(`${serverApiBase}/stats?date=${dateString}`, {
                method: 'GET',
                headers: {
                    ...getRequestHeaders(),
                },
            });

            if (!response.ok) {
                 const errorData = await response.json().catch(() => ({ error: `HTTP Error: ${response.status}` }));
                throw new Error(errorData.error || `Failed to load stats: ${response.status}`);
            }

            const statsData = await response.json();
            // console.debug(`[${pluginName}] Received stats for ${dateString}:`, statsData); // Debug log

            const entityIds = Object.keys(statsData);

            if (entityIds.length === 0) {
                $loadingMessage.text(`日期 ${dateString} 没有统计数据。`).show();
                return;
            }

            // Sort entities by total time descending (optional)
            entityIds.sort((a, b) => (statsData[b]?.totalTimeMs || 0) - (statsData[a]?.totalTimeMs || 0));

            entityIds.forEach(id => {
                const stats = statsData[id];
                const name = getEntityName(id);
                const totalMsg = (stats.userMsgCount || 0) + (stats.aiMsgCount || 0);
                const totalWords = (stats.userWordCount || 0) + (stats.aiWordCount || 0);

                const rowHtml = `
                    <tr>
                        <td>${name}</td>
                        <td>${formatDuration(stats.totalTimeMs || 0)}</td>
                        <td>${stats.userMsgCount || 0}</td>
                        <td>${stats.userWordCount || 0}</td>
                        <td>${stats.aiMsgCount || 0}</td>
                        <td>${stats.aiWordCount || 0}</td>
                        <td>${totalMsg}</td>
                        <td>${totalWords}</td>
                    </tr>
                `;
                $statsTableBody.append(rowHtml);
            });

            $loadingMessage.hide();
            $statsTable.show();

        } catch (error) {
            console.error(`[${pluginName}] Error loading or displaying stats for ${dateString}:`, error);
            $loadingMessage.text(`加载统计数据失败: ${error.message}`).show();
             $statsTable.hide();
        }
    }

    // --- Time Tracking Logic ---

    /** Calculates elapsed time since last start and sends it */
    function processAndSendTimeIncrement() {
        if (!isWindowFocused || !activeStartTime || !getCurrentContextEntityId()) {
            // console.debug(`[${pluginName}] Skipping time send: Focus=${isWindowFocused}, StartTime=${activeStartTime}, Entity=${getCurrentContextEntityId()}`);
            activeStartTime = null; // Reset start time if conditions not met
            return;
        }

        const now = Date.now();
        const durationMs = now - activeStartTime;

        if (durationMs > 100) { // Only send if duration is meaningful (e.g., > 100ms)
            sendTrackingData({ timeMs: durationMs });
            // console.debug(`[${pluginName}] Sent time increment: ${durationMs}ms`);
        }

        // CRITICAL: Reset start time for the next interval/event
        activeStartTime = now;
    }

    /** Starts the periodic time tracking interval */
    function startTrackingInterval() {
        stopTrackingInterval(); // Clear any existing interval first

        const entityId = getCurrentContextEntityId();
        if (!entityId) {
            // console.debug(`[${pluginName}] Not starting tracker: No active entity.`);
            return; // Don't start if no entity
        }

        // console.debug(`[${pluginName}] Starting tracking interval for entity ${entityId}. Focused: ${isWindowFocused}`);
        if (isWindowFocused) {
            activeStartTime = Date.now(); // Set start time only if focused
        } else {
            activeStartTime = null;
        }

        trackIntervalId = setInterval(processAndSendTimeIncrement, TRACKING_INTERVAL_MS);
    }

    /** Stops the time tracking interval and sends the final elapsed time */
    function stopTrackingInterval() {
        if (trackIntervalId) {
            clearInterval(trackIntervalId);
            trackIntervalId = null;
            // console.debug(`[${pluginName}] Stopped tracking interval.`);
            // Send any remaining time since the last interval tick or focus gain
            processAndSendTimeIncrement();
        }
         // Clear start time regardless of whether interval was running
         activeStartTime = null;
    }

    // --- Event Handlers ---

    /** Handles switching characters or groups */
    function handleEntityChange() {
        const newEntityId = getCurrentContextEntityId();
        // console.debug(`[${pluginName}] Entity changed. Old: ${currentEntityId}, New: ${newEntityId}`);

        // Stop tracking for the old entity (sends final time segment)
        stopTrackingInterval();

        currentEntityId = newEntityId;

        // Start tracking for the new entity (if one exists)
        if (currentEntityId) {
            startTrackingInterval();
        }
    }

    /** Handles new messages (sent or received) */
    function handleNewMessage(eventData) {
        // eventData might be just messageId or an object depending on ST version/event
        // We need to reliably get the message details. getContext() is usually the way.
        try {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) return;

            // Find the latest message, assuming it triggered the event.
            // This might need adjustment if events aren't always for the last message.
            // A more robust approach might involve checking messageId if provided by the event.
            const latestMessage = context.chat[context.chat.length - 1];
            if (!latestMessage) return;


            const entityId = getCurrentContextEntityId();
            if (!entityId) return; // Should not happen if message is added, but check anyway

            const wordCount = countWords(latestMessage.mes);
            const isUser = latestMessage.is_user === true;

            // console.debug(`[${pluginName}] New message detected. User: ${isUser}, Words: ${wordCount}, Entity: ${entityId}`);
            sendTrackingData({ msgInc: 1, wordInc: wordCount, isUser: isUser });

            // Optional: Reset active timer start on new message for potentially higher accuracy,
            // as message sending/receiving implies activity.
            if (isWindowFocused) {
                 activeStartTime = Date.now();
            }

        } catch (error) {
            console.error(`[${pluginName}] Error handling new message:`, error);
        }
    }

    // --- Initialization Flow ---
    try {
        // 1. Load and inject the UI template
        const uiHtml = await renderExtensionTemplateAsync(`third-party/${pluginId}`, 'ui');
        // Inject into the standard extensions settings area
        $('#extensions_settings').append(uiHtml); // Or use '#translation_container' if that's the target in your ST version
        console.log(`[${pluginName}] UI injected into #extensions_settings.`);

        // 2. Preload names initially
        await preloadEntityNames();

        // 3. Set up date picker and load initial stats for today
        const $datepicker = $('#usage-datepicker');
        const todayBeijing = getClientBeijingDateString();
        $datepicker.val(todayBeijing); // Set default to today
        loadAndDisplayStats(todayBeijing); // Load today's stats

        // 4. Bind UI event listeners
        $datepicker.on('change', function() {
            loadAndDisplayStats($(this).val());
        });
        $('#usage-refresh-button').on('click', () => {
            loadAndDisplayStats($datepicker.val());
        });

        // 5. Listen to SillyTavern core events for context changes
        // Use CHAT_CHANGED as a general indicator for potential character/group swaps
        eventSource.on(eventTypes.CHAT_CHANGED, handleEntityChange);
        // Use CHARACTER_LOADED and GROUP_LOADED if CHAT_CHANGED isn't reliable enough
        // eventSource.on(eventTypes.CHARACTER_LOADED, handleEntityChange); // Uncomment if needed
        // eventSource.on(eventTypes.GROUP_LOADED, handleEntityChange);     // Uncomment if needed

        // Listen for new messages
        eventSource.on(eventTypes.MESSAGE_SENT, handleNewMessage);
        eventSource.on(eventTypes.MESSAGE_RECEIVED, handleNewMessage); // Assumes AI messages trigger this

        // 6. Listen to window focus/blur events for time tracking
        $(window).on('focus', () => {
            if (!isWindowFocused) {
                // console.debug(`[${pluginName}] Window gained focus.`);
                isWindowFocused = true;
                // Restart timer, setting the start time NOW
                activeStartTime = Date.now();
                startTrackingInterval(); // Ensures interval is running if entity is selected
            }
        });
        $(window).on('blur', () => {
            if (isWindowFocused) {
                // console.debug(`[${pluginName}] Window lost focus.`);
                isWindowFocused = false;
                // Process the final time segment immediately
                processAndSendTimeIncrement();
                // Stop the interval, but keep entityId context
                 activeStartTime = null; // Clear start time as no longer focused
                 // No need to call stopTrackingInterval here, processAndSend handles the last bit,
                 // and interval will naturally not send when focus is lost.
                 // If you WANT the interval to stop completely on blur, call stopTrackingInterval() here.
            }
        });

        // 7. Listen for page unload (best effort to save last bit of time)
        $(window).on('beforeunload', () => {
            // console.debug(`[${pluginName}] Window unloading.`);
            // Send the very last time increment synchronously if possible (might not always work)
            // Note: fetch keepalive might be needed for more reliability here, but simple send first
             processAndSendTimeIncrement();
             // No need to stop interval explicitly, page is closing
        });

        // 8. Initial entity check and start tracking
        currentEntityId = getCurrentContextEntityId();
        if (currentEntityId) {
            startTrackingInterval();
             console.log(`[${pluginName}] Initial tracking started for entity: ${currentEntityId}`);
        } else {
             console.log(`[${pluginName}] No active entity on load. Waiting for entity change.`);
        }

        console.log(`[${pluginName}] Initialization complete.`);

    } catch (error) {
        console.error(`[${pluginName}] Initialization failed:`, error);
        // Optionally display an error message to the user in the UI
         $('#daily-usage-tracker-container .inline-drawer-content')
             .empty()
             .append('<p style="color: red; padding: 10px;">插件初始化失败，请检查控制台日志。</p>');
    }
});
