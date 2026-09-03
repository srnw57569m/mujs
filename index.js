const { Highrise, Events } = require("highrise.sdk.dev");
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
const OpenAI = require("openai");
const SpotifyWebApi = require('spotify-web-api-node');
require("colors");


// 🤖 إعداد توكن ومحرك Groq AI عبر مكتبة OpenAI
const GROQ_API_KEY = "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";
const ai = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1"
});

// 📚 تحميل ملف تعليمات البوت الخاص بالذكاء الاصطناعي
const botAiPath = path.join(__dirname, 'bot_ai.json');
let botAiContext = "";
if (fs.existsSync(botAiPath)) {
    try {
        const aiData = JSON.parse(fs.readFileSync(botAiPath, 'utf8'));
        botAiContext = aiData.system_instruction || "";
    } catch (e) {
        console.error(chalk.red("[ERROR] Failed to read bot_ai.json: " + e.message));
    }
}

const settings = {
    events: ['ready', 'playerJoin', 'playerLeave', 'messages'],
    reconnect: 1
};

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error(chalk.red("[ERROR] Configuration file (config.json) not found!"));
    process.exit(1);
}
let config = require(configPath);

// 🎨 لوحة الألوان الجديدة والمحدثة
const PALETTE = {
    SUCCESS:   "<#1ABC9C>", // أخضر نعناعي راقي
    HIGHLIGHT: "<#F1C40F>", // أصفر ذهبي مميز للبيانات المهمة
    WARN:      "<#E67E22>", // برتقالي دافئ للتنبيهات
    DANGER:    "<#E74C3C>", // أحمر مريح للتحذيرات والإلغاء
    INFO:      "<#3498DB>", // أزرق هادئ للبحث والمعلومات
    NEUTRAL:   "<#ECF0F1>"  // أبيض/رمادي فاتح للنصوص العادية
};

// دالة تغليف النص باللون المطلوب
function colorize(msgText, hexColor = PALETTE.NEUTRAL) {
    return `${hexColor}${msgText}`;
}

// 🌐 نظام الترجمات والردود
const messages = {
    ar: {

        READY:`👀 بيتلي جاهز وفي الانتظار`,

        WELCOME_SET_LANG: (owner) => 
            `👋 ${PALETTE.SUCCESS}أهلاً بكم!\n` +
            `${PALETTE.NEUTRAL}يرجى من مالك الغرفة تحديد اللغة\n` +
            `${PALETTE.HIGHLIGHT}@${owner}\n` +
            `${PALETTE.NEUTRAL}عن طريق كتابة:\n` +
            `${PALETTE.INFO}language ar\n` +
            `${PALETTE.NEUTRAL}أو\n` +
            `${PALETTE.INFO}language en\n\n` +
            `👋 ${PALETTE.SUCCESS}Welcome!\n` +
            `${PALETTE.NEUTRAL}Room owner please set the bot language:\n` +
            `${PALETTE.HIGHLIGHT}@${owner}\n` +
            `${PALETTE.NEUTRAL}By typing:\n` +
            `${PALETTE.INFO}language ar\n` +
            `${PALETTE.NEUTRAL}or\n` +
            `${PALETTE.INFO}language en`,

        LANG_SUCCESS: 
            `${PALETTE.SUCCESS}✅ تم تحديث لغة البوت إلى العربية بنجاح!`,

        SEARCHING: (user, query) => 
            `🔍 ${PALETTE.INFO}جاري البحث لـ` +
            `${PALETTE.HIGHLIGHT}@${user}\n` +
            `${PALETTE.NEUTRAL}•` +
            `${PALETTE.INFO}${query}` +
            `${PALETTE.NEUTRAL}•`,

        FOUND: (title, duration, pos, user) => 
            `✅ ${PALETTE.SUCCESS}تم العثور على الأغنية!\n` +
            `${PALETTE.NEUTRAL}العنوان:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}⏱️ المدة: ` +
            `${PALETTE.HIGHLIGHT}[${duration}]\n` +
            `${PALETTE.NEUTRAL}🔢 الترتيب في الانتظار: ` +
            `${PALETTE.HIGHLIGHT}#${pos}\n` +
            `${PALETTE.NEUTRAL}👤 طلب بواسطة: ` +
            `${PALETTE.HIGHLIGHT}@${user}`,

        AUTOPLAY_INTERRUPT: (user) => 
            `⚠️ ${PALETTE.WARN}تم إيقاف التشغيل التلقائي لإعطاء الأولوية لـ\n` +
            `${PALETTE.HIGHLIGHT}@${user}`,

        QUEUE_EMPTY: 
            `${PALETTE.NEUTRAL}طابور الأغاني فارغ حالياً.`,

        QUEUE_TITLE: (count) => 
            `📑 ${PALETTE.INFO}قائمة الانتظار الحالية\n` +
            `${PALETTE.HIGHLIGHT}(${count} أغاني):\n\n`,

        MORE_TRACKS: (count) => 
            `${PALETTE.NEUTRAL}... و\n` +
            `${PALETTE.HIGHLIGHT}${count}\n` +
            `${PALETTE.NEUTRAL}أغاني أخرى.`,

        NO_NP: 
            `${PALETTE.NEUTRAL}لا يوجد أغنية شغالة حالياً.`,

        NOW_PLAYING: (title, bar, current, total, owner) => 
            `🎵 ${PALETTE.SUCCESS}شغال الآن:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.INFO}${bar}\n` +
            `${PALETTE.NEUTRAL}⏱️ الوقت: ` +
            `${PALETTE.HIGHLIGHT}[${current} / ${total}]\n` +
            `${PALETTE.NEUTRAL}👤 طلب بواسطة: ` +
            `${PALETTE.HIGHLIGHT}${owner}`,

        NO_SKIP: 
            `${PALETTE.WARN}لا توجد أغنية شغالة لتخطيها.`,

        SKIPPED: (title, user, owner) => 
            `⏭️ ${PALETTE.DANGER}تم التخطي:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}👤 بواسطة: ` +
            `${PALETTE.HIGHLIGHT}@${user}\n` +
            `${PALETTE.NEUTRAL}📥 صاحب الطلب الأصلي: ` +
            `${PALETTE.HIGHLIGHT}${owner}`,

        CLEAR_SUCCESS: 
            `${PALETTE.DANGER}تم مسح طابور الأغاني بالكامل.`,

        CLEAR_OWNER_ONLY: 
            `${PALETTE.DANGER}عذراً، مالك البوت فقط من يستطيع مسح قائمة الانتظار.`,

        DEL_SUCCESS: (title) => 
            `${PALETTE.DANGER}تم إزالة أغنيتك:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.DANGER}من قائمة الانتظار.`,

        DEL_NO_SONGS: 
            `${PALETTE.WARN}ليس لديك أي أغاني في قائمة الانتظار لإزالتها.`,

        DOWNLOAD_FAILED: (title) => 
            `❌ ${PALETTE.DANGER}فشل تحميل:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.DANGER}جاري تخطيها للأغنية التالية...`,

        AUTOPLAY_ARMED: (sec) => 
            `📻 ${PALETTE.WARN}[تشغيل تلقائي] القائمة فارغة!\n` +
            `${PALETTE.NEUTRAL}سيتم بدء التشغيل التلقائي خلال ` +
            `${PALETTE.HIGHLIGHT}${sec}` +
            ` ${PALETTE.NEUTRAL}ثانية...`,

        AUTOPLAY_START: 
            `📻 ${PALETTE.INFO}[تشغيل تلقائي]\n` +
            `${PALETTE.SUCCESS}تم بدء محرك التشغيل التلقائي الآن...`,

        AUTOPLAY_NP: (title) => 
            `📻 ${PALETTE.INFO}[تشغيل تلقائي] شغال الآن:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"`,

        NOW_PLAYING_MSG: (title, owner) => 
            `🎵 ${PALETTE.SUCCESS}شغال الآن:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}طلب بواسطة ` +
            `${PALETTE.HIGHLIGHT}@${owner}`,

        REGISTER_SUCCESS: 
            `🎉 ${PALETTE.SUCCESS}تم تفعيل حسابك بنجاح!\n` +
            `${PALETTE.NEUTRAL}يمكنك الآن استخدام جميع أوامر البوت في الغرفة وستصلك إشعارات الخاص عند اقتراب دور أغانيك.`,

        REGISTER_REQUIRED: 
            `⚠️ ${PALETTE.WARN}يجب عليك إرسال كلمة\n` +
            `${PALETTE.HIGHLIGHT}(تسجيل)\n` +
            `${PALETTE.NEUTRAL}أو\n` +
            `${PALETTE.HIGHLIGHT}(register)\n` +
            `${PALETTE.NEUTRAL}في الخاص أولاً حتى تتمكن من استخدام أوامر البوت وتلقي الإشعارات!`,
        
        DM_NEXT_TRACK: (title) => 
            `⏳ ${PALETTE.WARN}تنبيه:\n` +
            `${PALETTE.NEUTRAL}أغنيتك المقابلة دورها تقريباً!\n` +
            `🎵 ${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}هي الأغنية القادمة مباشرة في القائمة. استعد!`,

        DM_NOW_PLAYING: (title) => 
            `🎧 ${PALETTE.SUCCESS}أغنيتك تعمل الآن في الغرفة!\n` +
            `🎵 ${PALETTE.HIGHLIGHT}"${title}"\n\n` +
            `📌 ${PALETTE.INFO}أدوات التحكم المتاحة لك من هنا:\n` +
            `${PALETTE.NEUTRAL}- أرسل\n` +
            `${PALETTE.HIGHLIGHT}• تخطي •\n` +
            `${PALETTE.NEUTRAL}أو\n` +
            `${PALETTE.HIGHLIGHT}• skip •\n` +
            `${PALETTE.NEUTRAL}لتخطي أغنيتك الحالية.\n\nلو محتاج مساعه اكتب يا بيتلي او بيتلي واستمتع بمساعده الذكاء الاصطتناعي.`,

        DM_PROMO: 
            `✨ ${PALETTE.INFO}لا تنسَ مشاركة أغانيك المفضلة مع الجميع في الغرفة!\n` +
            `${PALETTE.NEUTRAL}استخدم الأمر\n` +
            `${PALETTE.HIGHLIGHT}(شغل)\n` +
            `${PALETTE.NEUTRAL}أو\n` +
            `${PALETTE.HIGHLIGHT}(/play)\n` +
            `${PALETTE.NEUTRAL}داخل الشات لاستعراض ذوقك الموسيقي. 🎶🎧`,

        SKIP_NOT_YOURS: 
            `❌ ${PALETTE.DANGER}لا يمكنك تخطي هذه الأغنية لأنها ليست من طلبك!`,

        RECOVERY_MSG: (title, minutesStr) => `⚠️ ${PALETTE.WARN}تم اعادة الاتصال...\n` +
                    `${PALETTE.NEUTRAL}🔄 جاري استكمال الأغنية:\n` +
                    `${PALETTE.HIGHLIGHT}"${title}"\n` +
                    `${PALETTE.NEUTRAL}⏱️ بدءاً من الدقيقة: ` +
                    `${PALETTE.HIGHLIGHT}[${minutesStr}]`,
                    //`${PALETTE.NEUTRAL}👤 طلب بواسطة:` +
                    //`${PALETTE.HIGHLIGHT}@${current_track_info ? current_track_info.owner : 'System'}`, 

    },

    en: {

        READY:`👀 BeatlY is up and ready to pump the vibe!`,


        WELCOME_SET_LANG: (owner) => 
            `👋 ${PALETTE.SUCCESS}Welcome!\n` +
            `${PALETTE.NEUTRAL}Room owner please set the bot language:\n` +
            `${PALETTE.HIGHLIGHT}@${owner}\n` +
            `${PALETTE.NEUTRAL}By typing:\n` +
            `${PALETTE.INFO}language ar\n` +
            `${PALETTE.NEUTRAL}or\n` +
            `${PALETTE.INFO}language en`,

        LANG_SUCCESS: 
            `${PALETTE.SUCCESS}✅ Bot language updated to English successfully!`,

        SEARCHING: (user, query) => 
            `🔍 ${PALETTE.INFO}Searching for\n` +
            `${PALETTE.HIGHLIGHT}@${user}\n` +
            `${PALETTE.NEUTRAL}•` +
            `${PALETTE.INFO}${query}` +
            `${PALETTE.NEUTRAL}•`,

        FOUND: (title, duration, pos, user) => 
            `✅ ${PALETTE.SUCCESS}Found Track!\n` +
            `${PALETTE.NEUTRAL}Title:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}⏱️ Duration: ${PALETTE.HIGHLIGHT}[${duration}]\n` +
            `${PALETTE.NEUTRAL}🔢 Queue Position: ${PALETTE.HIGHLIGHT}#${pos}\n` +
            `${PALETTE.NEUTRAL}👤 Requested by: ${PALETTE.HIGHLIGHT}@${user}`,
            
            

        AUTOPLAY_INTERRUPT: (user) => 
            `⚠️ ${PALETTE.WARN}Interrupting autoplay to prioritize\n` +
            `${PALETTE.HIGHLIGHT}@${user}`,

        QUEUE_EMPTY: 
            `${PALETTE.NEUTRAL}The music queue is currently empty.`,

        QUEUE_TITLE: (count) => 
            `📑 ${PALETTE.INFO}Current Queue\n` +
            `${PALETTE.HIGHLIGHT}(${count} songs):\n\n`,

        MORE_TRACKS: (count) => 
            `${PALETTE.NEUTRAL}... and\n` +
            `${PALETTE.HIGHLIGHT}${count}\n` +
            `${PALETTE.NEUTRAL}more tracks.`,

        NO_NP: 
            `${PALETTE.NEUTRAL}No song is currently playing right now.`,

        NOW_PLAYING: (title, bar, current, total, owner) => 
            `🎵 ${PALETTE.SUCCESS}Now Playing:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.INFO}${bar}\n` +
            `${PALETTE.NEUTRAL}⏱️ Time: ` +
            `${PALETTE.HIGHLIGHT}[${current} / ${total}]\n` +
            `${PALETTE.NEUTRAL}👤 Requested by: ` +
            `${PALETTE.HIGHLIGHT}${owner}`,

        NO_SKIP: 
            `${PALETTE.WARN}There is no song playing to skip.`,

        SKIPPED: (title, user, owner) => 
            `⏭️ ${PALETTE.DANGER}Skipped Track:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}👤 Skipped by:` +
            `${PALETTE.HIGHLIGHT}@${user}\n` +
            `${PALETTE.NEUTRAL}📥 Originally requested by:` +
            `${PALETTE.HIGHLIGHT}${owner}`,

        CLEAR_SUCCESS: 
            `${PALETTE.DANGER}Music queue has been cleared completely.`,

        CLEAR_OWNER_ONLY: 
            `${PALETTE.DANGER}Only the bot owner can clear the queue.`,

        DEL_SUCCESS: (title) => 
            `${PALETTE.DANGER}Removed your song:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.DANGER}from the queue.`,

        DEL_NO_SONGS: 
            `${PALETTE.WARN}You don't have any songs in the queue to remove.`,

        DOWNLOAD_FAILED: (title) => 
            `❌ ${PALETTE.DANGER}Failed to download:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.DANGER}Skipping to next track...`,

        AUTOPLAY_ARMED: (sec) => 
            `📻 ${PALETTE.WARN}[AUTOPLAY] Queue is empty.\n` +
            `${PALETTE.NEUTRAL}Will launch Autoplay in ` +
            `${PALETTE.HIGHLIGHT}${sec}` +
            ` ${PALETTE.NEUTRAL}seconds...`,

        AUTOPLAY_START: 
            `📻 ${PALETTE.INFO}[AUTOPLAY]\n` +
            `${PALETTE.SUCCESS}Booting Auto-Play engine now...`,

        AUTOPLAY_NP: (title) => 
            `📻 ${PALETTE.INFO}[Auto-Play] Now Playing:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"`,

        NOW_PLAYING_MSG: (title, owner) => 
            `🎵 ${PALETTE.SUCCESS}Now Playing:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}Requested by ` +
            `${PALETTE.HIGHLIGHT}@${owner}`,

        REGISTER_SUCCESS: 
            `🎉 ${PALETTE.SUCCESS}Account activated successfully!\n` +
            `${PALETTE.NEUTRAL}You can now use all commands in the room and receive DM notifications for your tracks.`,

        REGISTER_REQUIRED: 
            `⚠️ ${PALETTE.WARN}You must send\n` +
            `${PALETTE.HIGHLIGHT}(register)\n` +
            `${PALETTE.NEUTRAL}or\n` +
            `${PALETTE.HIGHLIGHT}(تسجيل)\n` +
            `${PALETTE.NEUTRAL}in DM first to use bot commands and receive notifications!`,

        DM_NEXT_TRACK: (title) => 
            `⏳ ${PALETTE.WARN}Alert:\n` +
            `${PALETTE.NEUTRAL}Your requested song is up next!\n` +
            `🎵 ${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}Get ready!`,

        DM_NOW_PLAYING: (title) => 
            `🎧 ${PALETTE.SUCCESS}Your song is now playing in the room!\n` +
            `🎵 ${PALETTE.HIGHLIGHT}"${title}"\n\n` +
            `📌 ${PALETTE.INFO}Available Controls:\n` +
            `${PALETTE.NEUTRAL}- Send\n` +
            `${PALETTE.HIGHLIGHT}• skip •\n` +
            `${PALETTE.NEUTRAL}or\n` +
            `${PALETTE.HIGHLIGHT}• تخطي •\n` +
            `${PALETTE.NEUTRAL}to skip your currently playing track.\n\nIf you need help just type hey beatly or beatly here and enjoy with the AI.` ,

        DM_PROMO: 
            `✨ ${PALETTE.INFO}Don't forget to play your favorite tunes in the room!\n` +
            `${PALETTE.NEUTRAL}Use\n` +
            `${PALETTE.HIGHLIGHT}(/p)\n` +
            `${PALETTE.NEUTRAL}or\n` +
            `${PALETTE.HIGHLIGHT}(/play)\n` +
            `${PALETTE.NEUTRAL}in chat to share your playlist with everyone! 🎶🎧`,

        SKIP_NOT_YOURS: 
            `❌ ${PALETTE.DANGER}You cannot skip this song because you did not request it!`,

        RECOVERY_MSG: (title, minutesStr) => 
            `⚠️ ${PALETTE.WARN}Connection restored...\n` +
            `${PALETTE.NEUTRAL}🔄 Resuming track:\n` +
            `${PALETTE.HIGHLIGHT}"${title}"\n` +
            `${PALETTE.NEUTRAL}⏱️ Starting from minute: ` +
            `${PALETTE.HIGHLIGHT}[${minutesStr}]`,
            //`${PALETTE.NEUTRAL}👤 Requested by:` +
            //`${PALETTE.HIGHLIGHT}@${current_track_info ? current_track_info.owner : 'System'}`,
                    
    }
};

const registered_users_file = path.join(__dirname, 'registered_users.json');
let registered_users = [];

try { 
    registered_users = JSON.parse(fs.readFileSync(registered_users_file, 'utf8')); 
} catch(e) { 
    registered_users = []; 
}

function save_registered_users() {
    fs.writeFileSync(registered_users_file, JSON.stringify(registered_users, null, 4));
}

function getRegisteredUser(userId) {
    if (!userId) return null;
    const cleanId = String(userId).trim();
    return registered_users.find(u => {
        if (typeof u === 'object' && u !== null) {
            return u.id === cleanId || 
                   u.username === cleanId || 
                   u.conversation_id === cleanId ||
                   (u.id && cleanId.includes(u.id));
        }
        return u === cleanId;
    });
}

function isRegistered(userId) {
    return !!getRegisteredUser(userId);
}

// 📩 دالة إرسال الخاص
async function sendDM(userId, messageText, hexColor = PALETTE.NEUTRAL) {
    const userObj = getRegisteredUser(userId);
    const targetId = (userObj && userObj.conversation_id) ? userObj.conversation_id : userId;
    try {
        await bot.direct.send(targetId, colorize(messageText, hexColor));
        return true;
    } catch (e) {
        console.error(`[DM ERROR] Failed to send DM to ${targetId}:`, e.message);
        return false;
    }
}

// 💬 دالة إرسال الشات العام
async function sendRoomMessage(messageText, hexColor = PALETTE.NEUTRAL) {
    try {
        await bot.message.send(colorize(messageText, hexColor));
    } catch (e) {
        console.error(`[ROOM MSG ERROR]:`, e.message);
    }
}

// 👂 دالة إرسال الويسبر
async function sendWhisper(userId, messageText, hexColor = PALETTE.NEUTRAL) {
    try {
        await bot.whisper.send(userId, colorize(messageText, hexColor));
    } catch (e) {
        console.error(`[WHISPER ERROR]:`, e.message);
    }
}

function getLang() {
    return (config.language && messages[config.language]) ? config.language : 'en';
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error(chalk.red(`[ERROR] Failed to update config.json: ${e.message}`));
    }
}

const bot = new Highrise({
    Events: [
        Events.Ready,
        Events.Messages,
        Events.Joins,
        Events.DirectMessages,
        Events.Leaves,
        Events.Error,
        Events.Movements
    ],
    cache: true,
    AutoFetchMessages: true
}, settings.reconnect);

function logWithTime(colorFn, message) {
    const now = new Date();
    const timeStr = `[${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
    console.log(colorFn(`${timeStr} ${message}`));
}

const downloadsFolder = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsFolder)) {
    fs.mkdirSync(downloadsFolder, { recursive: true });
}
let botPosition = null;
let botUserId = null;
let song_queue = [];
let currently_playing = false;
let current_track_info = null; 
let play_event = false;
let play_task = false;
let ffmpeg_process = null;
let encode_process = null;

let ffmpeg_stop_generation = 0;
let ffmpeg_stop_promise = Promise.resolve();
let progress_interval = null;
let start_time_ms = 0;
let elapsed_paused_seconds = 0; 

let autoplay_tracks_raw = []; 
let autoplay_pool = [];       
let is_autoplay_active = false; 
let autoplay_timeout_handler = null; 
let is_searching = false;      
let myBotId = null;     

let playback_generation = 0;


const userSessions = new Map();

const queue_file = path.join(__dirname, 'song_queue.json');
const current_song_file = path.join(__dirname, 'current_song.json');

try { song_queue = JSON.parse(fs.readFileSync(queue_file, 'utf8')); } catch(e) { song_queue = []; }

function save_queue() {
    fs.writeFileSync(queue_file, JSON.stringify(song_queue, null, 4));
}

function format_time(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function saveBotPosition() {
    const locData = {
        bot_position: botPosition ? { x: botPosition.x, y: botPosition.y, z: botPosition.z, facing: botPosition.facing } : null,
        admins: [config.owner]
    };
    const filePath = path.join(__dirname, 'musicbot_pos.json');
    try {
        fs.writeFileSync(filePath, JSON.stringify(locData, null, 2), { encoding: 'UTF-8' });
        console.log(chalk.green("[INFO] Bot position saved successfully."));
    } catch (error) {
        console.error(chalk.red(`[ERROR] Failed to save bot position: ${error.message}`));
    }
}

function loadBotPosition() {
    const filePath = path.join(__dirname, 'musicbot_pos.json');
    try {
        if (!fs.existsSync(filePath)) {
            console.log(chalk.yellow("[INFO] No saved bot position found. Starting at default position."));
            return false;
        }

        const locData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const pos = locData.bot_position;
        if (pos && pos.x !== undefined && pos.y !== undefined && pos.z !== undefined && pos.facing !== undefined) {
            botPosition = pos;
            console.log(chalk.green("[INFO] Bot position loaded successfully."));
            return true;
        }
    } catch (err) {
        console.error(chalk.red(`[ERROR] Failed to load bot position: ${err.message}`));
    }
    return false;
}



function start_promo_messages_loop() {
    setInterval(async () => {
        if (registered_users.length === 0) return;
        const lang = getLang();
        logWithTime(chalk.cyan, `[PROMO] Sending promotional messages to ${registered_users.length} registered users...`);
        for (const u of registered_users) {
            const targetId = typeof u === 'object' ? u.id : u;
            await sendDM(targetId, messages[lang].DM_PROMO, PALETTE.INFO);
            await new Promise(r => setTimeout(r, 1000));
        }
    }, 60 * 60 * 1000);
}

async function fetch_autoplay_playlist() {
    if (!config.autoplay_list) {
        logWithTime(chalk.red, "[AUTOPLAY] No autoplay_list link found in config.json");
        return;
    }
    logWithTime(chalk.blue, `[AUTOPLAY] Fetching tracks from playlist metadata...`);
    
    return new Promise((resolve) => {
        const args = ['--flat-playlist', '--dump-json', config.autoplay_list];
        const env = { ...process.env };
        
        const ytPlaylist = spawn('yt-dlp', args, { env });
        let outputStr = "";
        
        ytPlaylist.stdout.on('data', (data) => { outputStr += data.toString(); });
        ytPlaylist.on('close', () => {
            const lines = outputStr.split('\n');
            autoplay_tracks_raw = [];
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.title && parsed.url) {
                        autoplay_tracks_raw.push({
                            title: parsed.title,
                            url: parsed.url,
                            duration: parsed.duration || 180
                        });
                    }
                } catch(e) {}
            }
            logWithTime(chalk.green, `[AUTOPLAY] Successfully loaded ${autoplay_tracks_raw.length} tracks into the pool configuration!`);
            resolve();
        });
    });
}

async function fetch_and_download_youtube(song_url, fallback_title = "Unknown", fallback_duration = 180) {
    return new Promise((resolve) => {
        const oldFiles = fs.readdirSync(downloadsFolder);
        for (const file of oldFiles) { 
            try { 
                const filePath = path.join(downloadsFolder, file);
                if (current_track_info && current_track_info.file_path === filePath) continue;
                
                const isPreloaded = song_queue.some(s => s.file_path === filePath);
                if (isPreloaded) continue;

                fs.unlinkSync(filePath); 
            } catch(e){} 
        }

        const uniqueId = Date.now();
        const outputTemplate = path.join(downloadsFolder, `${uniqueId}_%(id)s.%(ext)s`);
        
        const downloadArgs = [
            '--cookies', path.join(__dirname, 'cookies.txt'),
            '--js-runtimes', 'deno,node',
            '--format', 'ba/ba*',
            '--no-playlist',
            '--force-overwrites',
            '--output', outputTemplate,
            song_url
        ];
        
        const env = { ...process.env };
        const ytDownloader = spawn('yt-dlp', downloadArgs, { env });

        ytDownloader.stderr.on('data', (data) => {
            console.error(`\x1b[31m[yt-dlp Download Error]: ${data.toString()}\x1b[0m`);
        });

        ytDownloader.stdout.on('data', (data) => {
            console.log(`[yt-dlp Download Log]: ${data.toString().trim()}`);
        });
        
        ytDownloader.on('close', (code) => {
            console.log(`[yt-dlp] Process exited with code: ${code}`);
            const files = fs.readdirSync(downloadsFolder).filter(f => f.startsWith(`${uniqueId}_`));
            
            if (files.length > 0) {
                resolve({
                    file_path: path.join(downloadsFolder, files[0]),
                    real_title: fallback_title,
                    real_duration: fallback_duration
                });
            } else {
                console.error(`\x1b[31m[Error] Failed to find the downloaded file for ID: ${uniqueId}\x1b[0m`);
                resolve({ file_path: null, real_title: fallback_title, real_duration: fallback_duration });
            }
        });
    });
}

async function preload_next_song() {
    if (song_queue.length === 0) return;
    
    const next_song = song_queue[0];
    
    if (next_song.owner_id && !next_song.notified_next) {
        next_song.notified_next = true;
        const lang = getLang();
        await sendDM(next_song.owner_id, messages[lang].DM_NEXT_TRACK(next_song.title), PALETTE.WARN);
    }

    if (next_song.file_path || next_song.is_downloading) return;

    next_song.is_downloading = true;
    logWithTime(chalk.yellow, `[PRELOAD] Background downloading started for next song: "${next_song.title}"...`);

    const result = await fetch_and_download_youtube(next_song.url, next_song.title, next_song.duration);

    if (result.file_path) {
        next_song.file_path = result.file_path;
        logWithTime(chalk.green, `[PRELOAD] Next song is fully buffered and ready to play instantly: "${next_song.title}"`);
    } else {
        logWithTime(chalk.red, `[PRELOAD] Failed to pre-download: "${next_song.title}"`);
    }
    next_song.is_downloading = false;
}

async function stop_current_ffmpeg({ timeoutMs = 1500 } = {}) {
    const proc = ffmpeg_process;
    if (!proc) return;

    const genAtStop = ++ffmpeg_stop_generation;
    ffmpeg_process = proc;

    if (progress_interval) {
        clearInterval(progress_interval);
        progress_interval = null;
    }

    await new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try {
                proc.removeAllListeners('close');
                proc.removeAllListeners('error');
            } catch (e) {}
            if (ffmpeg_stop_generation === genAtStop) {
                ffmpeg_process = null;
            }
            resolve();
        };

        proc.once('close', () => finish());
        proc.once('error', () => finish());

        try {
            proc.kill('SIGTERM');
        } catch (e) {}

        setTimeout(() => {
            if (done) return;
            try {
                proc.kill('SIGKILL');
            } catch (e) {}
            finish();
        }, timeoutMs);
    });
}

async function stream_to_radioking(song_file_path, start_seconds = 0, payload = {}) {
    if (!song_file_path || !fs.existsSync(song_file_path)) {
        console.error(`\x1b[31m[FFMPEG ERROR] File path is invalid or does not exist: ${song_file_path}\x1b[0m`);
        return;
    }

    const radio = config.radio || {};
    const icecast_url = `icecast://${radio.username}:${radio.password}@${radio.icecast_server}:${radio.icecast_port}${radio.mount_point}`;

    await ffmpeg_stop_promise;

    return new Promise((resolve) => {
        if (progress_interval) {
            clearInterval(progress_interval);
            progress_interval = null;
        }

        const inputBase = [
            '-re',
            '-analyzeduration', '0',
            '-probesize', '32'
        ];

        const outputLowLatency = [
            '-bufsize', '512k',
            '-flush_packets', '1'
        ];

        const mode = payload && payload.mode ? payload.mode : (start_seconds === 0 ? 'copy' : 'reencode');
        let args;

        if (mode === 'copy') {
            args = [
                '-re',
                '-i', song_file_path,
                '-acodec', 'libmp3lame',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-f', 'mp3',
                '-content_type', 'audio/mpeg',
                '-bufsize', '512k',
                '-flush_packets', '1',
                icecast_url
            ];
        } else {
            args = [
                ...inputBase,
                '-ss', start_seconds.toString(),
                '-i', song_file_path,
                '-acodec', 'libmp3lame',
                '-ab', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-f', 'mp3',
                '-content_type', 'audio/mpeg',
                ...outputLowLatency,
                '-flush_packets', '1',
                icecast_url
            ];
        }

        const env = { ...process.env };
        ffmpeg_process = spawn('ffmpeg', args, { env });

        ffmpeg_process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (!msg) return;
            console.log(`[FFMPEG] ${msg}`);
        });

        start_time_ms = Date.now();
        elapsed_paused_seconds = start_seconds;

        progress_interval = setInterval(() => {
            const current_elapsed = elapsed_paused_seconds + Math.floor((Date.now() - start_time_ms) / 1000);
            if (current_track_info) {
                current_track_info.elapsed = current_elapsed;
                if (!is_autoplay_active) {
                    fs.writeFileSync(current_song_file, JSON.stringify(current_track_info, null, 4));
                }
            }
        }, 1500);

        ffmpeg_process.on('close', () => {
            clearInterval(progress_interval);
            resolve();
        });
    });
}

async function check_and_start_autoplay_timer() {
    if (autoplay_timeout_handler) {
        clearTimeout(autoplay_timeout_handler);
        autoplay_timeout_handler = null;
    }

    if (autoplay_tracks_raw.length === 0) return;
    if (play_task || currently_playing || song_queue.length > 0 || is_searching) return;

    const timer_generation = playback_generation;
    const wait_seconds = config.autoplay_timer !== undefined ? parseInt(config.autoplay_timer) : 60;
    const lang = getLang();

    logWithTime(chalk.magenta, `[AUTOPLAY] Queue is empty. Timer armed! Will launch Autoplay in ${wait_seconds} seconds...`);
    try {
        await sendRoomMessage(messages[lang].AUTOPLAY_ARMED(wait_seconds), PALETTE.WARN);
    } catch (err) {
        console.error("Failed to send autoplay timer message:", err);
    }

    autoplay_timeout_handler = setTimeout(() => {
        if (timer_generation !== playback_generation) return;
        if (is_searching) return;
        if (song_queue.length !== 0) return;
        if (currently_playing || play_task) return;

        play_event = true;
        play_task = true;
        is_autoplay_active = true;
        logWithTime(chalk.green, `[AUTOPLAY] Timer expired. Booting Auto-Play engine now...`);
        sendRoomMessage(messages[getLang()].AUTOPLAY_START, PALETTE.INFO);
        playback_loop();
    }, wait_seconds * 1000);
}

function interrupt_autoplay() {
    playback_generation++;

    if (autoplay_timeout_handler) {
        clearTimeout(autoplay_timeout_handler);
        autoplay_timeout_handler = null;
    }

    is_autoplay_active = false;
    clearInterval(progress_interval);

    ffmpeg_stop_promise = stop_current_ffmpeg({ timeoutMs: 2000 });

    if (encode_process) {
        try { encode_process.kill(); } catch (e) {}
    }

    currently_playing = false;
    current_track_info = null;
    play_event = false;
    play_task = false;
}

async function playback_loop() {
    play_event = true;

    while (play_event) {
        const lang = getLang();
        if (song_queue.length === 0) {
            if (is_autoplay_active && autoplay_tracks_raw.length > 0) {
                if (autoplay_pool.length === 0) autoplay_pool = [...autoplay_tracks_raw];
                const random_index = Math.floor(Math.random() * autoplay_pool.length);
                const chosen_track = autoplay_pool.splice(random_index, 1)[0];

                currently_playing = true;
                const result = await fetch_and_download_youtube(chosen_track.url, chosen_track.title, chosen_track.duration);
                
                if (!is_autoplay_active) {
                    if (result.file_path && fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
                    continue;
                }

                if (!result.file_path) {
                    logWithTime(chalk.red, `[AUTOPLAY] Failed to download track: ${chosen_track.title}. Skipping...`);
                    currently_playing = false;
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                current_track_info = { title: result.real_title, owner: "AutoPlay_System", owner_id: null, duration: result.real_duration, file_path: result.file_path, elapsed: 0 };
                await sendRoomMessage(messages[lang].AUTOPLAY_NP(current_track_info.title), PALETTE.INFO);
                
                preload_next_song();

                await stream_to_radioking(result.file_path, 0, { mode: 'copy' });
                
                if (fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
            } else {
                break;
            }
        } 
        else {
            is_autoplay_active = false;
            const next_song = song_queue.shift();
            save_queue();
            
            currently_playing = true;
            let result = null;

            if (next_song.file_path && fs.existsSync(next_song.file_path)) {
                logWithTime(chalk.green, `[PLAYBACK] Instantly launching preloaded track: "${next_song.title}"`);
                result = {
                    file_path: next_song.file_path,
                    real_title: next_song.title,
                    real_duration: next_song.duration
                };
            } else {
                if (next_song.is_downloading) {
                    logWithTime(chalk.yellow, `[PLAYBACK] Next song is finishing its preload cache, holding for a few moments...`);
                    while (next_song.is_downloading) {
                        await new Promise(r => setTimeout(r, 300));
                    }
                    if (next_song.file_path && fs.existsSync(next_song.file_path)) {
                        result = {
                            file_path: next_song.file_path,
                            real_title: next_song.title,
                            real_duration: next_song.duration
                        };
                    }
                }
                
                if (!result) {
                    result = await fetch_and_download_youtube(next_song.url, next_song.title, next_song.duration);
                }
            }

            if (!result.file_path) {
                await sendRoomMessage(messages[lang].DOWNLOAD_FAILED(next_song.title), PALETTE.DANGER);
                currently_playing = false;
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            current_track_info = { title: result.real_title, owner: next_song.owner, owner_id: next_song.owner_id, duration: result.real_duration, file_path: result.file_path, elapsed: 0 };
            
            fs.writeFileSync(current_song_file, JSON.stringify(current_track_info, null, 4));

            await sendRoomMessage(messages[lang].NOW_PLAYING_MSG(current_track_info.title, current_track_info.owner), PALETTE.SUCCESS);
            
            if (current_track_info.owner_id) {
                await sendDM(current_track_info.owner_id, messages[lang].DM_NOW_PLAYING(current_track_info.title), PALETTE.SUCCESS);
            }

            preload_next_song();

            await stream_to_radioking(result.file_path, 0, { mode: 'copy' });

            if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
            if (result.file_path && fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
        }

        currently_playing = false;
        current_track_info = null;
    }
    
    play_event = false;
    play_task = false;
    currently_playing = false;
    current_track_info = null;
    check_and_start_autoplay_timer();
}

bot.on('ready', async (session) => {
    logWithTime(chalk.green, `\n[Music Bot Ready] Connected successfully!`);
    logWithTime(chalk.cyan, `Logged in as Bot ID: ${session.user_id}`);
    myBotId = session.user_id;
    botUserId = session.user_id;
    const positionLoaded = loadBotPosition();
    //if (positionLoaded) {
        //await bot.player.teleport(session.user_id, botPosition.x, botPosition.y, botPosition.z, botPosition.facing);
    //} else {
    await bot.player.teleport(session.user_id, 16, 20, 28);
   // }

    if (!config.language || (config.language !== 'ar' && config.language !== 'en')) {
        await sendRoomMessage(messages.ar.WELCOME_SET_LANG(config.owner), PALETTE.WARN);
    }

    await fetch_autoplay_playlist();
    //start_promo_messages_loop();

    if (fs.existsSync(current_song_file)) {
        try {
            const saved_track = JSON.parse(fs.readFileSync(current_song_file, 'utf8'));
            if (saved_track && saved_track.file_path && fs.existsSync(saved_track.file_path)) {
                logWithTime(chalk.yellow, `[RECOVERY] Found interrupted track: "${saved_track.title}" at second ${saved_track.elapsed}`);
                const minutesStr = format_time(saved_track.elapsed);
                
                const lang = typeof getLang === 'function' ? getLang() : (config.language || 'ar');
                
                // استخدام صاحب الأغنية الحقيقي من الملف بدلاً من 'System'
                const requestedBy = saved_track.owner || saved_track.user || 'System';
                
                // تعديل دالة الرسالة لتستقبل اسم المستخدم أيضاً إذا لزم الأمر، أو طباعتها مباشرة:
                await sendRoomMessage(messages[lang].RECOVERY_MSG(
                    saved_track.title,
                    minutesStr,
                    requestedBy
                ), PALETTE.SUCCESS);
                
                currently_playing = true;
                current_track_info = saved_track;
                play_event = true;
                play_task = true;
                is_autoplay_active = false;

                (async () => {
                    await stream_to_radioking(saved_track.file_path, saved_track.elapsed, { mode: 'reencode' });
                    if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
                    if (fs.existsSync(saved_track.file_path)) { try { fs.unlinkSync(saved_track.file_path); } catch(e){} }
                    currently_playing = false;
                    current_track_info = null;
                    playback_loop();
                })();
                return;
            }
        } catch (e) {
            console.error(chalk.red("[RECOVERY ERROR] Cannot parse current_song.json"), e);
        }
    }
    await sendRoomMessage(messages[getLang()].READY, PALETTE.SUCCESS);
    if (song_queue.length > 0 && !play_task) {
        play_event = true;
        play_task = true;
        playback_loop();
    } else {
        check_and_start_autoplay_timer();
    }
});

bot.on("messageCreate", async (user, data, message) => {
  console.log(` ${user} sent a message: ${message}`);
  
  const cleanMsg = message.trim().toLowerCase();
  const lang = getLang();

  const conversation_id = data.id || ""; 
  let extracted_user_id = user;
  
  if (conversation_id.includes("1_on_1:")) {
      const parts = conversation_id.split(":");
      extracted_user_id = parts[1] || user;
  }

  if (cleanMsg === "تسجيل" || cleanMsg === "register") {
    const existingIndex = registered_users.findIndex(u => {
        if (typeof u === 'object' && u !== null) {
            return u.id === extracted_user_id || u.username === user || u.conversation_id === conversation_id;
        }
        return u === extracted_user_id;
    });

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const hoursStr = String(hours).padStart(2, '0');
    const formattedDate = `${year}-${month}-${day} | ${hoursStr}:${minutes}:${seconds} ${ampm}`;

    const newUserObj = {
        id: extracted_user_id,
        username: user,
        conversation_id: conversation_id,
        registered_at: formattedDate
    };

    if (existingIndex !== -1) {
        registered_users[existingIndex] = newUserObj;
        save_registered_users();

        const alreadyMsg = lang === 'ar' 
            ? `⚠️ ${PALETTE.WARN}تم تحديث بيانات تسجيلك بنجاح!`
            : `⚠️ ${PALETTE.WARN}Your registration details have been updated successfully!`;
        await sendDM(conversation_id, alreadyMsg, PALETTE.WARN);
        return;
    }

    registered_users.push(newUserObj);
    save_registered_users();

    await sendDM(conversation_id, messages[lang].REGISTER_SUCCESS, PALETTE.SUCCESS);
  }

  else if (cleanMsg === "تخطي" || cleanMsg === "skip") {
    if (!isRegistered(extracted_user_id) && !isRegistered(user)) {
        await sendDM(conversation_id, messages[lang].REGISTER_REQUIRED, PALETTE.WARN);
        return;
    }

    if (!currently_playing || !current_track_info) {
        await sendDM(conversation_id, messages[lang].NO_SKIP, PALETTE.WARN);
        return;
    }

    const isSongOwner = (current_track_info.owner_id && (current_track_info.owner_id === extracted_user_id || current_track_info.owner_id === user)) || 
                        (current_track_info.owner && current_track_info.owner.toLowerCase() === user.toLowerCase());
    const isBotOwner = user.toLowerCase() === config.owner.toLowerCase();

    if (isSongOwner || isBotOwner) {
        const display_owner = is_autoplay_active ? "System (Auto-Play)" : `@${current_track_info.owner}`;
        
        await sendRoomMessage(messages[lang].SKIPPED(current_track_info.title, user, display_owner), PALETTE.DANGER);
        
        const dmSkipConfirm = lang === 'ar' 
            ? `⏭️ ${PALETTE.DANGER}تم تخطي أغنيتك\n${PALETTE.HIGHLIGHT}("${current_track_info.title}")\n${PALETTE.DANGER}بنجاح!` 
            : `⏭️ ${PALETTE.DANGER}Your song\n${PALETTE.HIGHLIGHT}("${current_track_info.title}")\n${PALETTE.DANGER}has been skipped successfully!`;
        await sendDM(conversation_id, dmSkipConfirm, PALETTE.DANGER);
        
        clearInterval(progress_interval);
        ffmpeg_stop_promise = stop_current_ffmpeg({ timeoutMs: 1500 });

        if (encode_process) {
            try { encode_process.kill(); } catch (e) {}
        }

        if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
        
        currently_playing = false;
        current_track_info = null;
        playback_generation++;
    } else {
        await sendDM(conversation_id, messages[lang].SKIP_NOT_YOURS, PALETTE.DANGER);
    }
  }
    // 🤖 المعالجة بواسطة الذكاء الاصطناعي (Groq AI)
             // 🤖 المعالجة بواسطة الذكاء الاصطناعي (Groq AI)
    else {
                  const AI_TIMEOUT_MS = 18000;
                  const SEARCH_TIMEOUT_MS = 9000;
                  const SESSION_TTL_MS = 10 * 60 * 1000;
                  const MAX_HISTORY = 12;
              
                  const rawMsg = String(message || "").trim();
                  if (!rawMsg) return;
              
                  function withTimeout(promise, ms, label = "Operation") {
                      return Promise.race([
                          promise,
                          new Promise((_, reject) =>
                              setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
                          )
                      ]);
                  }
              
                  function detectLanguage(text) {
                      const value = String(text || "").trim();
              
                      if (!value) return "ar";
              
                      const arabicChars = (value.match(/[\u0600-\u06FF]/g) || []).length;
                      const englishChars = (value.match(/[A-Za-z]/g) || []).length;
              
                      if (arabicChars === 0 && englishChars > 0) {
                          return "en";
                      }
              
                      if (englishChars === 0 && arabicChars > 0) {
                          return "ar";
                      }
              
                      if (arabicChars > englishChars) {
                          return "ar";
                      }
              
                      if (englishChars > arabicChars) {
                          return "en";
                      }
              
                      return getLang() === "en" ? "en" : "ar";
                  }
              
                  function detectStyle(text, language) {
                      const value = String(text || "").toLowerCase();
              
                      if (language === "en") {
                          if (/(bro|broo|yo|sup|dude|fam|man|fr|lol|lmao|wanna|gonna|fire|crazy|lit)/i.test(value)) {
                              return "casual English";
                          }
              
                          return "natural English";
                      }
              
                      if (/(يسطا|يستا|يا عم|يعم|يا نجم|بقولك|بقولك ايه|بص|عامل ايه|ازيك|ايه الاخبار|جامد|فاجر|خد|هات|عايز|عاوز|طب|بقا|بقى|يلا|عاش|حلو)/i.test(value)) {
                          return "Egyptian casual";
                      }
              
                      return "Egyptian friendly";
                  }
              
                  function cleanArabicText(text) {
                      return String(text || "")
                          .replace(/[\u064B-\u0652]/g, "")
                          .replace(/[إأآ]/g, "ا")
                          .replace(/ى/g, "ي")
                          .replace(/ة/g, "ه")
                          .replace(/ـ/g, "")
                          .replace(/\s+/g, " ")
                          .trim();
                  }
              
                  function normalizeSearchText(text) {
                      return cleanArabicText(text)
                          .toLowerCase()
                          .replace(/[“”"']/g, "")
                          .replace(/[؟?!.,،؛:()[\]{}]/g, " ")
                          .replace(/\s+/g, " ")
                          .trim();
                  }
              
                  function safeJsonParse(text) {
                      try {
                          let cleaned = String(text || "").trim();
              
                          cleaned = cleaned
                              .replace(/^```json\s*/i, "")
                              .replace(/^```\s*/i, "")
                              .replace(/\s*```$/i, "")
                              .trim();
              
                          const firstBrace = cleaned.indexOf("{");
                          const lastBrace = cleaned.lastIndexOf("}");
              
                          if (firstBrace !== -1 && lastBrace !== -1) {
                              cleaned = cleaned.substring(firstBrace, lastBrace + 1);
                          }
              
                          return JSON.parse(cleaned);
                      } catch {
                          return null;
                      }
                  }
              
                  async function callBeatlyAI(messages, options = {}) {
                      const request = ai.chat.completions.create({
                          model: options.model || "openai/gpt-oss-120b",
                          messages,
                          temperature: options.temperature ?? 0.2,
                          max_tokens: options.max_tokens || 350
                      });
              
                      return withTimeout(
                          request,
                          options.timeout || AI_TIMEOUT_MS,
                          "Groq AI"
                      );
                  }
              
                  // ================================
                  // 🎵 Spotify Engine
                  // ================================
              
                  let spotifyToken = null;
                  let spotifyTokenExpiresAt = 0;
              
                  const musicSearchCache = new Map();
                  const MUSIC_CACHE_TTL = 60 * 60 * 1000;
              
                  async function getSpotifyToken() {
                      const clientId =
                          process.env.SPOTIFY_CLIENT_ID ||
                          "84b3198ef3764a7795437daeeda0b61e";
              
                      const clientSecret =
                          process.env.SPOTIFY_CLIENT_SECRET ||
                          "bc9451b2693346d6afca94977847919e";
              
                      if (!clientId || !clientSecret) {
                          throw new Error(
                              "Spotify credentials are missing. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET."
                          );
                      }
              
                      if (
                          spotifyToken &&
                          Date.now() < spotifyTokenExpiresAt - 30000
                      ) {
                          return spotifyToken;
                      }
              
                      const credentials = Buffer
                          .from(`${clientId}:${clientSecret}`)
                          .toString("base64");
              
                      const response = await withTimeout(
                          fetch("https://accounts.spotify.com/api/token", {
                              method: "POST",
                              headers: {
                                  "Authorization": `Basic ${credentials}`,
                                  "Content-Type": "application/x-www-form-urlencoded"
                              },
                              body: "grant_type=client_credentials"
                          }),
                          SEARCH_TIMEOUT_MS,
                          "Spotify authentication"
                      );
              
                      if (!response.ok) {
                          throw new Error(
                              `Spotify authentication failed: HTTP ${response.status}`
                          );
                      }
              
                      const data = await response.json();
              
                      if (!data.access_token) {
                          throw new Error("Spotify returned no access token.");
                      }
              
                      spotifyToken = data.access_token;
                      spotifyTokenExpiresAt =
                          Date.now() + ((data.expires_in || 3600) * 1000);
              
                      return spotifyToken;
                  }
              
                  async function spotifyRequest(endpoint, retry = true) {
                      const token = await getSpotifyToken();
              
                      const response = await withTimeout(
                          fetch(`https://api.spotify.com/v1/${endpoint}`, {
                              headers: {
                                  "Authorization": `Bearer ${token}`
                              }
                          }),
                          SEARCH_TIMEOUT_MS,
                          "Spotify request"
                      );
              
                      if (response.status === 401 && retry) {
                          spotifyToken = null;
                          spotifyTokenExpiresAt = 0;
              
                          return spotifyRequest(endpoint, false);
                      }
              
                      if (!response.ok) {
                          throw new Error(
                              `Spotify HTTP ${response.status}`
                          );
                      }
              
                      return response.json();
                  }
              
                  async function searchSpotify(query, limit = 8) {
                      const cleaned = normalizeSearchText(query);
              
                      if (!cleaned) {
                          return {
                              tracks: [],
                              artists: []
                          };
                      }
              
                      const cacheKey = `spotify:${cleaned}:${limit}`;
                      const cached = musicSearchCache.get(cacheKey);
              
                      if (
                          cached &&
                          Date.now() - cached.timestamp < MUSIC_CACHE_TTL
                      ) {
                          return cached.data;
                      }
              
                      try {
                          const endpoint =
                              `search?q=${encodeURIComponent(cleaned)}` +
                              `&type=track,artist` +
                              `&limit=${limit}`;
              
                          const data = await spotifyRequest(endpoint);
              
                          const result = {
                              tracks: (data.tracks?.items || []).map(track => ({
                                  title: track.name || "",
                                  artist: (track.artists || [])
                                      .map(a => a.name)
                                      .join(", "),
                                  album: track.album?.name || "",
                                  popularity: Number(track.popularity) || 0,
                                  url: track.external_urls?.spotify || "",
                                  id: track.id || "",
                                  source: "Spotify"
                              })),
              
                              artists: (data.artists?.items || []).map(artist => ({
                                  name: artist.name || "",
                                  popularity: Number(artist.popularity) || 0,
                                  url: artist.external_urls?.spotify || "",
                                  id: artist.id || "",
                                  source: "Spotify"
                              }))
                          };
              
                          musicSearchCache.set(cacheKey, {
                              timestamp: Date.now(),
                              data: result
                          });
              
                          return result;
                      } catch (error) {
                          console.error(
                              chalk.yellow(
                                  `[BEATLY SPOTIFY] ${error.message}`
                              )
                          );
              
                          return {
                              tracks: [],
                              artists: []
                          };
                      }
                  }
              
                  // ================================
                  // 🔎 Search Ranking
                  // ================================
              
                  function scoreTrack(track, query, intent = {}) {
                      const q = normalizeSearchText(query);
                      const title = normalizeSearchText(track.title);
                      const artist = normalizeSearchText(track.artist);
              
                      if (!title) return 0;
              
                      let score = 0;
              
                      if (title === q) {
                          score += 150;
                      }
              
                      if (
                          title.includes(q) ||
                          q.includes(title)
                      ) {
                          score += 70;
                      }
              
                      const queryWords = q
                          .split(/\s+/)
                          .filter(Boolean);
              
                      for (const word of queryWords) {
                          if (word.length < 2) continue;
              
                          if (title.includes(word)) {
                              score += 15;
                          }
              
                          if (artist.includes(word)) {
                              score += 12;
                          }
                      }
              
                      if (intent.song_title) {
                          const requestedTitle =
                              normalizeSearchText(intent.song_title);
              
                          if (title === requestedTitle) {
                              score += 160;
                          } else if (
                              title.includes(requestedTitle) ||
                              requestedTitle.includes(title)
                          ) {
                              score += 75;
                          }
                      }
              
                      if (intent.artist) {
                          const requestedArtist =
                              normalizeSearchText(intent.artist);
              
                          if (
                              artist === requestedArtist
                          ) {
                              score += 130;
                          } else if (
                              artist.includes(requestedArtist) ||
                              requestedArtist.includes(artist)
                          ) {
                              score += 90;
                          }
                      }
              
                      score += Math.min(
                          Number(track.popularity) || 0,
                          100
                      ) * 0.2;
              
                      return score;
                  }
              
                  function rankTracks(tracks, query, intent = {}) {
                      return [...tracks]
                          .map(track => ({
                              ...track,
                              score: scoreTrack(
                                  track,
                                  query,
                                  intent
                              )
                          }))
                          .sort((a, b) => b.score - a.score);
                  }
              
                  // ================================
                  // ▶️ YouTube Fallback
                  // ================================
              
                  async function searchYouTube(query) {
                      return new Promise(resolve => {
                          let finished = false;
                          let output = "";
              
                          const args = [
                              "--cookies",
                              path.join(__dirname, "cookies.txt"),
                              "--js-runtimes",
                              "deno,node",
                              "--flat-playlist",
                              "--dump-json",
                              "--no-warnings",
                              "--skip-download",
                              "ytsearch5:" + query
                          ];
              
                          let yt;
              
                          try {
                              yt = spawn(
                                  "yt-dlp",
                                  args,
                                  {
                                      env: {
                                          ...process.env
                                      }
                                  }
                              );
                          } catch (error) {
                              resolve([]);
                              return;
                          }
              
                          const timer = setTimeout(() => {
                              if (finished) return;
              
                              finished = true;
              
                              try {
                                  yt.kill("SIGKILL");
                              } catch {}
              
                              resolve([]);
                          }, SEARCH_TIMEOUT_MS);
              
                          yt.stdout.on("data", data => {
                              output += data.toString();
                          });
              
                          yt.on("error", error => {
                              if (finished) return;
              
                              finished = true;
                              clearTimeout(timer);
              
                              console.error(
                                  chalk.yellow(
                                      `[BEATLY YOUTUBE] ${error.message}`
                                  )
                              );
              
                              resolve([]);
                          });
              
                          yt.on("close", () => {
                              if (finished) return;
              
                              finished = true;
                              clearTimeout(timer);
              
                              const results = [];
              
                              for (
                                  const line of output.split("\n")
                              ) {
                                  if (!line.trim()) continue;
              
                                  try {
                                      const item = JSON.parse(line);
              
                                      if (!item.title) continue;
              
                                      results.push({
                                          title: item.title,
                                          artist:
                                              item.uploader ||
                                              item.channel ||
                                              "",
                                          duration:
                                              Number(item.duration) || 0,
                                          url:
                                              item.webpage_url ||
                                              (
                                                  item.id
                                                      ? `https://www.youtube.com/watch?v=${item.id}`
                                                      : ""
                                              ),
                                          id: item.id || "",
                                          source: "YouTube"
                                      });
                                  } catch {}
                              }
              
                              resolve(results);
                          });
                      });
                  }
              
                  // ================================
                  // 🎧 Deezer Fallback
                  // ================================
              
                  async function searchDeezer(query) {
                      try {
                          const response = await withTimeout(
                              fetch(
                                  `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=8`
                              ),
                              SEARCH_TIMEOUT_MS,
                              "Deezer search"
                          );
              
                          if (!response.ok) {
                              return [];
                          }
              
                          const data = await response.json();
              
                          return (data.data || []).map(track => ({
                              title: track.title || "",
                              artist: track.artist?.name || "",
                              album: track.album?.title || "",
                              popularity: 0,
                              duration:
                                  Number(track.duration) || 0,
                              url: track.link || "",
                              id: String(track.id || ""),
                              source: "Deezer"
                          }));
                      } catch (error) {
                          console.error(
                              chalk.yellow(
                                  `[BEATLY DEEZER] ${error.message}`
                              )
                          );
              
                          return [];
                      }
                  }
              
                  // ================================
                  // 🎵 Music Search Engine
                  // ================================
              
                  async function buildMusicContext(intent, fallbackQuery) {
                      let searchQuery =
                          intent.search_query ||
                          intent.song_title ||
                          intent.artist ||
                          intent.lyrics ||
                          fallbackQuery;
              
                      searchQuery = String(searchQuery || "").trim();
              
                      if (
                          !searchQuery ||
                          searchQuery.toUpperCase() === "NONE"
                      ) {
                          return {
                              context: "",
                              results: []
                          };
                      }
              
                      // --------------------------------
                      // 1️⃣ Spotify PRIMARY
                      // --------------------------------
              
                      const spotifyData =
                          await searchSpotify(
                              searchQuery,
                              8
                          );
              
                      let rankedSpotify =
                          rankTracks(
                              spotifyData.tracks || [],
                              searchQuery,
                              intent
                          );
              
                      if (
                          rankedSpotify.length > 0 &&
                          rankedSpotify[0].score >= 45
                      ) {
                          const topResults =
                              rankedSpotify.slice(0, 5);
              
                          const context = [
                              "[MUSIC_SEARCH_RESULTS]",
                              "SOURCE: Spotify",
                              "SEARCH_SUCCESS: true",
                              ...topResults.map(
                                  (track, index) =>
                                      `${index + 1}. "${track.title}" — ${track.artist}` +
                                      (
                                          track.album
                                              ? ` — Album: ${track.album}`
                                              : ""
                                      )
                              ),
                              "[/MUSIC_SEARCH_RESULTS]"
                          ].join("\n");
              
                          return {
                              context,
                              results: topResults
                          };
                      }
              
                      // --------------------------------
                      // 2️⃣ YouTube FALLBACK
                      // --------------------------------
              
                      const youtubeResults =
                          await searchYouTube(
                              searchQuery
                          );
              
                      if (youtubeResults.length > 0) {
                          const topResults =
                              youtubeResults.slice(0, 5);
              
                          const context = [
                              "[MUSIC_SEARCH_RESULTS]",
                              "SOURCE: YouTube",
                              "SEARCH_SUCCESS: true",
                              ...topResults.map(
                                  (track, index) =>
                                      `${index + 1}. "${track.title}" — ${track.artist || "Unknown artist"}`
                              ),
                              "[/MUSIC_SEARCH_RESULTS]"
                          ].join("\n");
              
                          return {
                              context,
                              results: topResults
                          };
                      }
              
                      // --------------------------------
                      // 3️⃣ Deezer FALLBACK
                      // --------------------------------
              
                      const deezerResults =
                          await searchDeezer(
                              searchQuery
                          );
              
                      if (deezerResults.length > 0) {
                          const rankedDeezer =
                              rankTracks(
                                  deezerResults,
                                  searchQuery,
                                  intent
                              );
              
                          const topResults =
                              rankedDeezer.slice(0, 5);
              
                          const context = [
                              "[MUSIC_SEARCH_RESULTS]",
                              "SOURCE: Deezer",
                              "SEARCH_SUCCESS: true",
                              ...topResults.map(
                                  (track, index) =>
                                      `${index + 1}. "${track.title}" — ${track.artist}`
                              ),
                              "[/MUSIC_SEARCH_RESULTS]"
                          ].join("\n");
              
                          return {
                              context,
                              results: topResults
                          };
                      }
              
                      // --------------------------------
                      // ❌ Nothing Found
                      // --------------------------------
              
                      return {
                          context: [
                              "[MUSIC_SEARCH_RESULTS]",
                              "SEARCH_SUCCESS: false",
                              "No verified music result was found.",
                              "[/MUSIC_SEARCH_RESULTS]"
                          ].join("\n"),
                          results: []
                      };
                  }
              
                  // ================================
                  // 🧠 Session
                  // ================================
              
                  const language =
                      detectLanguage(rawMsg);
              
                  const style =
                      detectStyle(
                          rawMsg,
                          language
                      );
              
                  let session =
                      userSessions.get(
                          extracted_user_id
                      );
              
                  const nowTime = Date.now();
              
                  if (
                      !session ||
                      nowTime - session.lastInteraction >=
                          SESSION_TTL_MS
                  ) {
                      session = {
                          lastInteraction: nowTime,
                          history: [],
                          lastMusicContext: null,
                          lastSearchResults: []
                      };
                  }
              
                  session.lastInteraction =
                      nowTime;
              
                  session.history.push({
                      role: "user",
                      content: rawMsg
                  });
              
                  if (
                      session.history.length >
                      MAX_HISTORY
                  ) {
                      session.history =
                          session.history.slice(
                              -MAX_HISTORY
                          );
                  }
              
                  const recentHistory =
                      session.history.slice(-8);
              
                  // ================================
                  // 🎯 Intent Detection
                  // ================================
              
                  let intent = {
                      type: "chat",
                      search_query: "",
                      artist: "",
                      song_title: "",
                      lyrics: "",
                      mood: "",
                      language
                  };
              
                  const musicHints =
                      /(اغنيه|اغنية|اغاني|أغاني|مزيكا|موسيقى|اسمع|شغل|شغلي|شغللي|سمعني|song|songs|music|listen|play|track|artist|singer|lyrics|كلمات|كوبليه|مطرب|مغني|فنان|فنانة|مود|mood|sad|happy|love|romantic|حزين|هادئ|هادي|هادية|حماسي|شبه|زي|like)/i;
              
                  const followupHints =
                      /(واحده تانيه|واحدة تانية|واحده ثانيه|واحدة ثانية|اللي بعدها|بعدها|تاني|ثاني|another one|another|next one|one more|different one)/i;
              
                  try {
                      if (
                          musicHints.test(rawMsg) ||
                          followupHints.test(rawMsg) ||
                          session.lastMusicContext
                      ) {
                          const intentCompletion =
                              await callBeatlyAI(
                                  [
                                      {
                                          role: "system",
                                          content: `
         أنت محرك فهم الموسيقى الخاص بـ BeatlY.
         مهمتك تحليل رسالة المستخدم الأخيرة فقط مع سياق المحادثة.
         لا ترد على المستخدم.
         
         أخرج JSON صالح فقط:
         
         {
           "type": "chat|track|artist|lyrics|recommendation|followup",
           "search_query": "",
           "artist": "",
           "song_title": "",
           "lyrics": "",
           "mood": "",
           "language": "ar|en"
         }
         
         القواعد:
         - الكلام العادي بدون طلب موسيقى = chat.
         - اسم أغنية محددة = track.
         - طلب أغاني لفنان = artist.
         - المستخدم يذكر جزءاً من كلمات أغنية = lyrics.
         - طلب أغنية حسب مود أو مشابهة = recommendation.
         - "واحدة تانية" أو "another one" أو "اللي بعدها" = followup.
         - لو followup استخدم آخر سياق موسيقي.
         - search_query يجب أن يكون عبارة بحث حقيقية ومختصرة.
         - لا تكتب شرحاً داخل search_query.
         - لا تخترع اسم أغنية أو فنان.
         - لو المستخدم قال اسم فنان فقط، اجعله artist.
         - لو المستخدم قال اسم أغنية وفنان، ضع الاثنين في search_query.
         - لو المستخدم كتب عربي وإنجليزي، حدد اللغة الغالبة من آخر رسالة.
         `
                                      },
                                      ...recentHistory
                                  ],
                                  {
                                      temperature: 0,
                                      max_tokens: 220,
                                      timeout: 12000
                                  }
                              );
              
                          const content =
                              intentCompletion
                                  .choices[0]
                                  ?.message
                                  ?.content
                                  ?.trim();
              
                          const parsed =
                              safeJsonParse(
                                  content
                              );
              
                          if (parsed) {
                              intent = {
                                  ...intent,
                                  ...parsed
                              };
              
                              if (
                                  parsed.language !== "ar" &&
                                  parsed.language !== "en"
                              ) {
                                  intent.language =
                                      language;
                              }
                          }
                      }
                  } catch (error) {
                      console.error(
                          chalk.yellow(
                              `[BEATLY INTENT] ${error.message}`
                          )
                      );
                  }
              
                  // ================================
                  // 🔄 Follow-up Context
                  // ================================
              
                  const isMusicIntent =
                      [
                          "track",
                          "artist",
                          "lyrics",
                          "recommendation",
                          "followup"
                      ].includes(
                          intent.type
                      );
              
                  if (
                      intent.type === "followup" &&
                      session.lastMusicContext
                  ) {
                      intent = {
                          ...session.lastMusicContext,
                          ...intent,
                          search_query:
                              intent.search_query ||
                              session.lastMusicContext.search_query ||
                              rawMsg
                      };
              
                      // منع البحث عن "واحدة تانية"
                      // كأنها اسم أغنية.
                      if (
                          followupHints.test(
                              rawMsg
                          )
                      ) {
                          intent.search_query =
                              session.lastMusicContext.search_query ||
                              session.lastMusicContext.artist ||
                              session.lastMusicContext.song_title ||
                              "";
                      }
                  }
              
                  let musicContext = "";
                  let musicResults = [];
              
                  if (isMusicIntent) {
                      try {
                          const musicData =
                              await buildMusicContext(
                                  intent,
                                  rawMsg
                              );
              
                          musicContext =
                              musicData.context;
              
                          musicResults =
                              musicData.results;
              
                          session.lastMusicContext = {
                              ...intent
                          };
              
                          session.lastSearchResults =
                              musicResults;
                      } catch (error) {
                          console.error(
                              chalk.yellow(
                                  `[BEATLY MUSIC ENGINE] ${error.message}`
                              )
                          );
              
                          musicContext = [
                              "[MUSIC_SEARCH_RESULTS]",
                              "SEARCH_SUCCESS: false",
                              "Music search temporarily failed.",
                              "[/MUSIC_SEARCH_RESULTS]"
                          ].join("\n");
                      }
                  }
              
                  // ================================
                  // 📚 BeatlY Commands Knowledge
                  // ================================
              
                  const commandGuide = `
         BeatlY is a music bot inside Highrise.
         
         IMPORTANT:
         DM is for chatting, music help, recommendations and bot help.
         The actual music playback happens in the room.
         
         Registration:
         "تسجيل"
         "register"
         
         Play:
         "شغل [اسم الأغنية]"
         "/play [اسم الأغنية]"
         
         Queue:
         "الانتظار"
         "/queue"
         "/q"
         
         Now Playing:
         "شغال"
         "/np"
         
         Skip:
         "تخطي"
         "skip"
         
         Delete own queued song:
         "مسح"
         "حذف"
         "/del"
         
         Clear the entire queue:
         "تفريغ"
         "/clearq"
         
         IMPORTANT:
         /clearq is only for the bot owner NXLN@.
         
         IMPORTANT:
         Never claim that sending a DM played a song.
         To actually play music, the user must use the play command in the room.
         `;
              
                  // ================================
                  // 🤖 Final Response AI
                  // ================================
              
                  const responseSystem = `
         أنت BeatlY AI داخل بوت ميوزك في لعبة Highrise.
         المطور والمالك هو NXLN@.
         
         أنت مساعد موسيقى وشات، مش مجرد محرك بحث.
         
         أسلوبك:
         - سريع.
         - طبيعي.
         - جدع.
         - خفيف.
         - فاهم جو المستخدم.
         - لا تتكلم بطريقة روبوتية.
         
         LANGUAGE RULE:
         - لو المستخدم بيتكلم English بالكامل، رد English.
         - لو المستخدم بيتكلم عربي، رد عربي.
         - لو المستخدم بيتكلم Egyptian Arabic، رد بنفس اللهجة المصرية.
         - لو المستخدم casual، كن casual.
         - لو المستخدم English casual، استخدم natural casual English.
         - لو الرسالة mixed Arabic/English، حافظ على الـmix الطبيعي.
         - لا تحول المصري إلى فصحى.
         - لا تستخدم لغة مختلفة عن المستخدم بدون سبب.
         
         STYLE:
         - ممنوع "كيف يمكنني مساعدتك؟"
         - ممنوع "يسعدني مساعدتك".
         - ممنوع الردود الرسمية.
         - استخدم إيموجيات خفيفة فقط.
         - لا تكرر BeatlY بلا داعي.
         - الرد غالباً سطر أو سطرين.
         - لو المستخدم طلب شرحاً، ممكن تطول بالقدر المطلوب.
         
         MUSIC RULES:
         - نتائج [MUSIC_SEARCH_RESULTS] هي المصدر الموثوق الوحيد لأسماء الأغاني والفنانين.
         - ممنوع اختراع أغنية أو فنان.
         - ممنوع تأليف نتيجة بحث.
         - لو SEARCH_SUCCESS=false لا تدعي أنك وجدت الأغنية.
         - اطلب من المستخدم اسم أوضح أو جزء أكبر من الكلمات.
         
         CONTEXT:
         - لو المستخدم قال "واحدة تانية"، افهم أنه يقصد نتيجة مختلفة عن آخر بحث.
         - لو قال "اللي بعدها"، استخدم آخر سياق موسيقي.
         - لو قال "حاجة أهدى"، حافظ على الفنان أو السياق السابق لو موجود.
         - لو قال "واحدة شبهها"، استخدم آخر أغنية كسياق.
         
         BOT COMMANDS:
         - تشغيل الأغنية يتم في الروم، وليس من الـDM.
         - لو سأل عن طريقة التشغيل، قل له الأمر المناسب.
         - لا تدعي أنك شغلت الأغنية من الـDM.
         
         USER LANGUAGE:
         ${language}
         
         USER STYLE:
         ${style}
         
         ${commandGuide}
         
         ${musicContext}
         `;
              
                  const apiMessages = [
                      {
                          role: "system",
                          content: responseSystem
                      },
                      ...session.history.slice(
                          -MAX_HISTORY
                      )
                  ];
              
                  // ================================
                  // 💬 Generate Final Reply
                  // ================================
              
                  try {
                      const chatCompletion =
                          await callBeatlyAI(
                              apiMessages,
                              {
                                  temperature:
                                      language === "en"
                                          ? 0.35
                                          : 0.25,
                                  max_tokens: 300,
                                  timeout:
                                      AI_TIMEOUT_MS
                              }
                          );
              
                      let replyText =
                          chatCompletion
                              .choices[0]
                              ?.message
                              ?.content
                              ?.trim();
              
                      if (!replyText) {
                          replyText =
                              language === "en"
                                  ? "Yo bro 😎🎧 I'm here. What you wanna listen to?"
                                  : "معاك يا نجم 😎🎧 عايز تسمع إيه؟";
                      }
              
                      replyText =
                          replyText
                              .replace(
                                  /^```[\s\S]*?```$/g,
                                  ""
                              )
                              .trim();
              
                      // منع Markdown البشع
                      replyText =
                          replyText
                              .replace(/^#{1,6}\s*/gm, "")
                              .replace(/\*\*/g, "")
                              .trim();
              
                      // حد أقصى للرد
                      if (
                          replyText.length >
                          700
                      ) {
                          replyText =
                              replyText
                                  .substring(
                                      0,
                                      697
                                  )
                                  .trim() +
                              "...";
                      }
              
                      session.history.push({
                          role: "assistant",
                          content: replyText
                      });
              
                      if (
                          session.history.length >
                          MAX_HISTORY
                      ) {
                          session.history =
                              session.history.slice(
                                  -MAX_HISTORY
                              );
                      }
              
                      session.lastInteraction =
                          Date.now();
              
                      userSessions.set(
                          extracted_user_id,
                          session
                      );
              
                      // ==================================
                      // 📩 إرسال الرد
                      // ==================================
              
                      const sent =
                          await sendDM(
                              conversation_id,
                              replyText,
                              PALETTE.INFO
                          );
              
                      if (!sent) {
                          console.error(
                              chalk.red(
                                  "[BEATLY AI] DM sending failed."
                              )
                          );
                      }
                  } catch (error) {
                      console.error(
                          chalk.red(
                              `[GROQ AI ERROR] ${error.message}`
                          )
                      );
              
                      // ==================================
                      // 🛟 Guaranteed Fallback
                      // ==================================
              
                      const fallbackReply =
                          language === "en"
                              ? "I'm here bro 😎🎧 Tell me the song name or what vibe you're looking for."
                              : "معاك يا نجم 😎🎧 قولي اسم الأغنية أو المود اللي عايزه.";
              
                      try {
                          await sendDM(
                              conversation_id,
                              fallbackReply,
                              PALETTE.INFO
                          );
                      } catch (sendError) {
                          console.error(
                              chalk.red(
                                  `[BEATLY FALLBACK DM ERROR] ${sendError.message}`
                              )
                          );
                      }
                  }
        }
});

bot.on('chatCreate', async (user, message) => {
    logWithTime(chalk.yellow, `[CHAT] @${user.username}: ${message}`);
    const lowerMessage = message.toLowerCase().trim();

    if (user.username.toLowerCase() === config.owner.toLowerCase()) {
        const langKeywords = ["/lang", "language", "تغيير اللغة", "تغير اللغة", "اللغة", "اللوغة","تغيير اللغه","تغير اللغه","اللغه","اللغة"];
        let selectedLang = null;

        if (lowerMessage === "ar" || lowerMessage === "en") {
            selectedLang = lowerMessage;
        } else {
            for (const kw of langKeywords) {
                if (lowerMessage.startsWith(kw)) {
                    const arg = lowerMessage.replace(kw, "").trim();
                    if (arg === "ar" || arg === "عربي" || arg === "arabic") selectedLang = "ar";
                    if (arg === "en" || arg === "انجليزي" || arg === "إنجليزي" || arg === "english") selectedLang = "en";
                }
            }
        }

        if (selectedLang) {
            config.language = selectedLang;
            saveConfig();
            await sendRoomMessage(messages[selectedLang].LANG_SUCCESS, PALETTE.SUCCESS);
            return;
        }
    }

    const lang = getLang();

    const isBotCommand = lowerMessage.startsWith("/play ") || lowerMessage.startsWith("/p ") || 
                         lowerMessage.startsWith("شغل ") || lowerMessage.startsWith("تشغيل ") ||
                         lowerMessage === "/q" || lowerMessage === "/queue" || lowerMessage === "الانتظار" || lowerMessage === "الطابور" ||
                         lowerMessage === "/np" || lowerMessage === "شغال" || lowerMessage === "الان" ||
                         lowerMessage === "/skip" || lowerMessage === "تخطي" || lowerMessage === "سكيب" ||
                         lowerMessage === "/del" || lowerMessage === "مسح" || lowerMessage === "حذف";

    if (isBotCommand && !isRegistered(user.id)) {
        await sendWhisper(user.id, messages[lang].REGISTER_REQUIRED, PALETTE.WARN);
        return; 
    }

    if (!config.language || (config.language !== 'ar' && config.language !== 'en')) {
        const isCommandAttempt = lowerMessage.startsWith("/") || 
            ["شغل", "تشغيل", "الانتظار", "الطابور", "شغال", "الان", "تخطي", "سكيب", "تفريغ", "مسح", "حذف"].some(k => lowerMessage.startsWith(k));

        if (isCommandAttempt) {
            await sendRoomMessage(
                `⚠️ ${PALETTE.WARN}لا يمكن استخدام البوت الآن!\n` +
                `${PALETTE.NEUTRAL}يجب على مالك الغرفة تحديد اللغة أولاً:\n` +
                `${PALETTE.HIGHLIGHT}@${config.owner}\n` +
                `${PALETTE.INFO}language ar\n` +
                `${PALETTE.NEUTRAL}أو\n` +
                `${PALETTE.INFO}language en`, 
                PALETTE.WARN
            );
            return;
        }
    }

    if (lowerMessage.startsWith("/play ") || lowerMessage.startsWith("/p ") || lowerMessage.startsWith("شغل ") || lowerMessage.startsWith("تشغيل ")) {
        let songQuery = "";
        if (lowerMessage.startsWith("/play ")) songQuery = message.substring(6).trim();
        else if (lowerMessage.startsWith("/p ")) songQuery = message.substring(3).trim();
        else if (lowerMessage.startsWith("شغل ")) songQuery = message.substring(4).trim();
        else if (lowerMessage.startsWith("تشغيل ")) songQuery = message.substring(6).trim();

        if (!songQuery) return;

        playback_generation++; 
        is_searching = true;
        
        if (is_autoplay_active === true) {
            logWithTime(chalk.yellow, `[AUTOPLAY] Interrupting autoplay to prioritize @${user.username}`);
            await sendRoomMessage(messages[lang].AUTOPLAY_INTERRUPT(user.username), PALETTE.WARN);
            interrupt_autoplay();
        }

        await sendWhisper(user.id, messages[lang].SEARCHING(user.username, songQuery), PALETTE.INFO);

        const metaArgs = [
            '--cookies', path.join(__dirname, 'cookies.txt'),
            '--js-runtimes', 'deno,node',
            '--dump-json',
            `ytsearch1:${songQuery}`
        ];
        const env = { ...process.env };

        let metaDataStr = '';
        const ytMeta = spawn('yt-dlp', metaArgs, { env });
        
        ytMeta.stdout.on('data', (data) => { metaDataStr += data.toString(); });
        ytMeta.on('close', async () => {
            let finalTitle = songQuery;
            let finalDuration = 180;
            let videoUrl = `ytsearch1:${songQuery}`;

            try {
                const parsed = JSON.parse(metaDataStr);
                finalTitle = parsed.title || finalTitle;
                finalDuration = parsed.duration || finalDuration;
                if (parsed.webpage_url) {
                    videoUrl = parsed.webpage_url;
                } else if (parsed.id) {
                    videoUrl = `https://www.youtube.com/watch?v=${parsed.id}`;
                }
            } catch (e) {}

            const song = { 
                title: finalTitle, 
                owner: user.username, 
                owner_id: user.id, 
                duration: finalDuration, 
                url: videoUrl,
                notified_next: false 
            };
            
            song_queue.push(song);
            save_queue();
            is_searching = false;

            await sendRoomMessage(messages[getLang()].FOUND(finalTitle, format_time(finalDuration), song_queue.length, user.username), PALETTE.SUCCESS);

            preload_next_song();

            play_event = true;
            if (!play_task) {
                play_task = true;
                playback_loop();
            }
        });
    }
    
    else if (lowerMessage === "/q" || lowerMessage === "/queue" || lowerMessage === "الانتظار" || lowerMessage === "الطابور") {
        if (song_queue.length === 0) {
            await sendRoomMessage(messages[lang].QUEUE_EMPTY, PALETTE.NEUTRAL);
            return;
        }
        
        let queue_message = messages[lang].QUEUE_TITLE(song_queue.length);
        song_queue.slice(0, 5).forEach((song, idx) => {
            const cleanTitle = song.title.length > 35 ? song.title.substring(0, 35) + "..." : song.title;
            queue_message += `${idx + 1} - 🔽\n"${cleanTitle}"\n👤 Req by: @${song.owner}\n\n`;
        });
        
        if (song_queue.length > 5) {
            queue_message += messages[lang].MORE_TRACKS(song_queue.length - 5);
        }
        
        await sendWhisper(user.id, queue_message, PALETTE.INFO);
    }

    else if (lowerMessage === "/np" || lowerMessage === "شغال" || lowerMessage === "الان") {
        if (!currently_playing || !current_track_info) {
            await sendRoomMessage(messages[lang].NO_NP, PALETTE.NEUTRAL);
            return;
        }

        const current_elapsed = elapsed_paused_seconds + Math.floor((Date.now() - start_time_ms) / 1000);
        const total_duration = current_track_info.duration;
        
        const bar_total_elements = 15;
        const progress_ratio = Math.min(current_elapsed / total_duration, 1);
        const current_ball_position = Math.round(progress_ratio * bar_total_elements);

        let progress_bar = "";
        for (let i = 0; i <= bar_total_elements; i++) {
            if (i === current_ball_position) { progress_bar += "●"; } else { progress_bar += "➖"; }
        }

        const display_owner = is_autoplay_active ? "System (Auto-Play)" : `@${current_track_info.owner}`;
        await sendWhisper(user.id, messages[lang].NOW_PLAYING(current_track_info.title, progress_bar, format_time(current_elapsed), format_time(total_duration), display_owner), PALETTE.INFO);
    }
    
    else if (lowerMessage === "/skip" || lowerMessage === "تخطي" || lowerMessage === "سكيب") {
        if (!currently_playing || !current_track_info) {
            await sendRoomMessage(messages[lang].NO_SKIP, PALETTE.WARN);
            return;
        }

        const isSongOwner = (current_track_info.owner_id && current_track_info.owner_id === user.id) || 
                            (current_track_info.owner && current_track_info.owner.toLowerCase() === user.username.toLowerCase());
        const isBotOwner = user.username.toLowerCase() === config.owner.toLowerCase();

        if (isSongOwner || isBotOwner) {
            const display_owner = is_autoplay_active ? "System (Auto-Play)" : `@${current_track_info.owner}`;
            await sendRoomMessage(messages[lang].SKIPPED(current_track_info.title, user.username, display_owner), PALETTE.DANGER);
            
            clearInterval(progress_interval);
            ffmpeg_stop_promise = stop_current_ffmpeg({ timeoutMs: 1500 });

            if (encode_process) {
                try { encode_process.kill(); } catch (e) {}
            }

            if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
            
            currently_playing = false;
            current_track_info = null;
            playback_generation++;
        } else {
            await sendWhisper(user.id, messages[lang].SKIP_NOT_YOURS, PALETTE.DANGER);
        }
    }

    else if (lowerMessage === "/clearq" || lowerMessage === "تفريغ") {
        if (user.username.toLowerCase() === config.owner.toLowerCase()) {
            for (const song of song_queue) {
                if (song.file_path && fs.existsSync(song.file_path)) {
                    try { fs.unlinkSync(song.file_path); } catch(e){}
                }
            }
            song_queue = [];
            save_queue();
            await sendRoomMessage(messages[lang].CLEAR_SUCCESS, PALETTE.DANGER);
            if (!currently_playing) check_and_start_autoplay_timer();
        } else {
            await sendRoomMessage(messages[lang].CLEAR_OWNER_ONLY, PALETTE.DANGER);
        }
    }
    
    else if (lowerMessage === "/del" || lowerMessage === "مسح" || lowerMessage === "حذف") {
        let idx = song_queue.findIndex(s => s.owner_id === user.id || s.owner.toLowerCase() === user.username.toLowerCase());
        if (idx !== -1) {
            const removed = song_queue.splice(idx, 1)[0];
            if (removed.file_path && fs.existsSync(removed.file_path)) {
                try { fs.unlinkSync(removed.file_path); } catch(e){}
            }
            save_queue();
            await sendRoomMessage(messages[lang].DEL_SUCCESS(removed.title), PALETTE.DANGER);
            
            preload_next_song();
            
            if (song_queue.length === 0 && !currently_playing) check_and_start_autoplay_timer();
        } else {
            await sendRoomMessage(messages[lang].DEL_NO_SONGS, PALETTE.WARN);
        }
    }

    if (user.username === config.owner || (config.admins && config.admins.includes(user.username))) {
           
        if (message.startsWith("/setpos")) {
            console.log(`[DEBUG] Attempting to retrieve position for user ID: ${user.id}`);
  
            try {
                // جلب بيانات جميع اللاعبين المتواجدين والغرفة
                const roomPlayers = await bot.room.players.get();
  
                // البحث عن اللاعب بناءً على user.id
                const playerEntry = roomPlayers.find(p => p[0].id === user.id);
  
                // التحقق من وجود اللاعب وموقعه
                if (!playerEntry) {
                    console.error(`[ERROR] Failed to retrieve position for user ID: ${user.id}`);
                    await bot.message.send("Failed to retrieve your position. Please move around and try again.");
                    return;
                }
  
                // استخراج إحداثيات الموقع
                const position = playerEntry[1];
        
                // حفظ موقع البوت الجديد
                botPosition = position;
                saveBotPosition();

                await bot.message.send("Bot position set! Refreshing...");
    
                // الانتظار لحظة قبل إعادة التموضع
                await new Promise(resolve => setTimeout(resolve, 2000));

                if (!botUserId) {
                    console.error("[ERROR] Bot user ID is not set. Unable to teleport.");
                    await bot.message.send("Error: Could not teleport bot. Please restart the bot and try again.");
                    return;
                }

                // نقل البوت إلى المكان المحدد
                await bot.player.teleport(botUserId, botPosition.x, botPosition.y, botPosition.z, botPosition.facing);

                await bot.message.send("Bot has been refreshed to the new position!");

            } catch (error) {
                console.error(`[ERROR] Error fetching player data: ${error.message}`);
                await bot.message.send("An error occurred while retrieving your position.");
            }
        }   
    }
});

bot.on('error', (error) => {
    console.error(chalk.red(`[Highrise Error]:`), error);
});

bot.login(config.token, config.room_id);
