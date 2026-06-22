const { Highrise, GatewayIntentBits } = require("highrise.sdk");
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { spawn } = require('child_process');
require("colors");

const settings = {
    events: ['ready', 'playerJoin', 'playerLeave', 'messages'],
    reconnect: 1
};

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
    console.error(chalk.red("[ERROR] Configuration file (config.json) not found!"));
    process.exit(1);
}
const config = require(configPath);

const bot = new Highrise({
    intents: [
        GatewayIntentBits.Ready,
        GatewayIntentBits.Messages,
        GatewayIntentBits.Joins,
        GatewayIntentBits.Leaves,
        GatewayIntentBits.Error
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

let song_queue = [];
let currently_playing = false;
let current_track_info = null; 
let play_event = false;
let play_task = false;
let ffmpeg_process = null;
let encode_process = null;

// Graceful FFmpeg handoff coordination
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

// Single-flight state machine guard
let playback_generation = 0;

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

async function fetch_autoplay_playlist() {
    if (!config.autoplay_list) {
        logWithTime(chalk.red, "[AUTOPLAY] No autoplay_list link found in config.json");
        return;
    }
    logWithTime(chalk.blue, `[AUTOPLAY] Fetching tracks from playlist metadata...`);
    
    return new Promise((resolve) => {
        const args = ['--flat-playlist', '--dump-json', config.autoplay_list];
        const env = { ...process.env };
        delete env.NODE_CHANNEL_FD; delete env.NODE_UNIQUE_ID; delete env.NODE_OPTIONS;
        
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

async function fetch_and_download_youtube(song_request, isUrl = false) {
    return new Promise((resolve) => {
        const target = isUrl ? song_request : `ytsearch1:${song_request}`;
        const metaArgs = ['--dump-json', target];
        const env = { ...process.env };
        delete env.NODE_CHANNEL_FD; delete env.NODE_UNIQUE_ID; delete env.NODE_OPTIONS;

        let metaDataStr = '';
        const ytMeta = spawn('yt-dlp', metaArgs, { env });
        
        ytMeta.stdout.on('data', (data) => { metaDataStr += data.toString(); });
        
        ytMeta.on('close', () => {
            let title = song_request;
            let duration = 180;
            
            try {
                const parsed = JSON.parse(metaDataStr);
                title = parsed.title || title;
                duration = parsed.duration || duration;
            } catch (e) {}

            // تنظيف الملفات القديمة قبل تحميل الملف الجديد عشان الـ Recovery يشتغل صح وما يمسحش نفسه
            const oldFiles = fs.readdirSync(downloadsFolder);
            for (const file of oldFiles) { 
                try { 
                    // لو الأغنية الحالية بتستخدم الملف ده، متنسحهوش عشان الـ Recovery لو حصل فصل مفاجئ
                    if (current_track_info && current_track_info.file_path === path.join(downloadsFolder, file)) continue;
                    fs.unlinkSync(path.join(downloadsFolder, file)); 
                } catch(e){} 
            }

            // توليد اسم ملف فريد ومعتمد على الوقت لتجنب التداخل أثناء الـ Recovery والتحميلات الجديدة
            const uniqueId = Date.now();
            const outputTemplate = path.join(downloadsFolder, `${uniqueId}_%(id)s.%(ext)s`);
            const downloadArgs = ['--quiet', '--extract-audio', '--audio-format', 'mp3', '--output', outputTemplate, target];
            
            const ytDownloader = spawn('yt-dlp', downloadArgs, { env });
            ytDownloader.on('close', () => {
                const files = fs.readdirSync(downloadsFolder).filter(f => f.startsWith(`${uniqueId}_`));
                if (files.length > 0) {
                    resolve({
                        file_path: path.join(downloadsFolder, files[0]),
                        real_title: title,
                        real_duration: duration
                    });
                } else {
                    resolve({ file_path: null, real_title: title, real_duration: duration });
                }
            });
        });
    });
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
        delete env.NODE_CHANNEL_FD; delete env.NODE_UNIQUE_ID; delete env.NODE_OPTIONS;

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
                // تحديث ملف الـ Recovery بالثواني الحالية باستمرار للأغاني الحقيقية فقط وليس الأوتوبلاي
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

function check_and_start_autoplay_timer() {
    if (autoplay_timeout_handler) {
        clearTimeout(autoplay_timeout_handler);
        autoplay_timeout_handler = null;
    }

    if (autoplay_tracks_raw.length === 0) return;
    if (play_task || currently_playing || song_queue.length > 0 || is_searching) return;

    const timer_generation = playback_generation;
    const wait_seconds = config.autoplay_timer !== undefined ? parseInt(config.autoplay_timer) : 60;
    logWithTime(chalk.magenta, `[AUTOPLAY] Queue is empty. Timer armed! Will launch Autoplay in ${wait_seconds} seconds...`);

    autoplay_timeout_handler = setTimeout(() => {
        if (timer_generation !== playback_generation) return;
        if (is_searching) return;
        if (song_queue.length !== 0) return;
        if (currently_playing || play_task) return;

        play_event = true;
        play_task = true;
        is_autoplay_active = true;
        logWithTime(chalk.green, `[AUTOPLAY] Timer expired. Booting Auto-Play engine now...`);
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
        // 1. لو الكيو فاضي والأوتوبلاي شغال
        if (song_queue.length === 0) {
            if (is_autoplay_active && autoplay_tracks_raw.length > 0) {
                if (autoplay_pool.length === 0) autoplay_pool = [...autoplay_tracks_raw];
                const random_index = Math.floor(Math.random() * autoplay_pool.length);
                const chosen_track = autoplay_pool.splice(random_index, 1)[0];

                currently_playing = true;
                const result = await fetch_and_download_youtube(chosen_track.url, true);
                
                if (!is_autoplay_active) {
                    if (result.file_path && fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
                    continue;
                }

                current_track_info = { title: result.real_title, owner: "AutoPlay_System", duration: result.real_duration, file_path: result.file_path, elapsed: 0 };
                await bot.message.send(`📻 [Auto-Play] Now Playing: "${current_track_info.title}"`);
                await stream_to_radioking(result.file_path, 0, { mode: 'copy' });
                
                if (fs.existsSync(result.file_path)) fs.unlinkSync(result.file_path);
            } else {
                break;
            }
        } 
        // 2. لو فيه أغنية في الكيو الحقيقي
        else {
            is_autoplay_active = false;
            const next_song = song_queue.shift();
            save_queue();
            
            currently_playing = true;
            const result = await fetch_and_download_youtube(next_song.title);

            current_track_info = { title: result.real_title, owner: next_song.owner, duration: result.real_duration, file_path: result.file_path, elapsed: 0 };
            
            // إنشاء ملف حفظ الأغنية الحالية لضمان استرجاعها فوراً لو حصل فصل مفاجئ
            fs.writeFileSync(current_song_file, JSON.stringify(current_track_info, null, 4));

            await bot.message.send(`🎵 Now Playing: \n"${current_track_info.title}" \nRequested by @${current_track_info.owner}`);
            await stream_to_radioking(result.file_path, 0, { mode: 'copy' });

            // مسح ملف الـ Recovery بعد انتهاء الأغنية بسلام بنجاح
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
    // 1. قراءة وتنظيف الداتا من الملف
    // 1. قراءة وتنظيف الداتا من الملف
    const posPath = path.join(__dirname, 'musicbot_pos.json');
    if (fs.existsSync(posPath)) {
        try {
            const posData = JSON.parse(fs.readFileSync(posPath, 'utf8'));
            
            const cleanStr = posData.bot_position.replace('}', '');
            const parts = cleanStr.split(',').reduce((acc, part) => {
                const [key, val] = part.split('=');
                if (key && val) {
                    // تنظيف كامل من الفراغات وعلامات التنصيص المفردة والمزدوجة
                    acc[key.trim()] = val.trim().replace(/['"]/g, '');
                }
                return acc;
            }, {});

            // 2. تأخير النقل لمدة ثانيتين عشان نضمن رسبنة البوت
            setTimeout(async () => {
                try {
                    // الـ SDK طالب الفورمات دي بالظبط: FrontRight, FrontLeft, BackRight, BackLeft
                    // الكود ده هيضمن إن أول حرف من كل كلمة كابيتال والباقي سمول تبعا لطلب الـ SDK
                    let facingDirection = parts.facing;
                    if (facingDirection.toLowerCase() === 'frontright') facingDirection = 'FrontRight';
                    if (facingDirection.toLowerCase() === 'frontleft') facingDirection = 'FrontLeft';
                    if (facingDirection.toLowerCase() === 'backright') facingDirection = 'BackRight';
                    if (facingDirection.toLowerCase() === 'backleft') facingDirection = 'BackLeft';

                    await bot.player.teleport(
                        session.user_id, 
                        parseFloat(parts.x), 
                        parseFloat(parts.y), 
                        parseFloat(parts.z), 
                        facingDirection
                    );
                    logWithTime(chalk.green, `[TELEPORT SUCCESS] Bot successfully moved to: x=${parts.x}, y=${parts.y}, z=${parts.z}, facing=${facingDirection}`);
                } catch (teleportErr) {
                    console.error(chalk.red("[TELEPORT DELAYED ERROR] Failed inside timeout:"), teleportErr.message);
                }
            }, 2000);

        } catch (e) {
            console.error(chalk.red("[TELEPORT ERROR] Failed to parse musicbot_pos.json, using default fallback:"), e);
            await bot.player.teleport(session.user_id, 0, 0, 0);
        }
    } else {
        await bot.player.teleport(session.user_id, 0, 0, 0);
    }
    await fetch_autoplay_playlist();

    // تشغيل الـ Recovery للإنقاذ عند إعادة تشغيل البوت
    // تشغيل الـ Recovery للإنقاذ عند إعادة تشغيل البوت
    if (fs.existsSync(current_song_file)) {
        try {
            const saved_track = JSON.parse(fs.readFileSync(current_song_file, 'utf8'));
            if (saved_track && saved_track.file_path && fs.existsSync(saved_track.file_path)) {
                logWithTime(chalk.yellow, `[RECOVERY] Found interrupted track: "${saved_track.title}" at second ${saved_track.elapsed}`);
                
                // حساب دقيقة الفصل بالظبط للرسالة
                const minutesStr = format_time(saved_track.elapsed);
                
                await bot.message.send(`⚠️ Reconnected now... \n🔄 Resuming track: \n"${saved_track.title}" \nStarting from: [${minutesStr}]⏱️ \n👤 Requested by: @${saved_track.owner}`);
                currently_playing = true;
                current_track_info = saved_track;
                play_event = true;
                play_task = true;
                is_autoplay_active = false;

                (async () => {
                    // تشغيل الأغنية من الثانية اللي وقفت عندها باستخدام reencode بثبات تام
                    await stream_to_radioking(saved_track.file_path, saved_track.elapsed, { mode: 'reencode' });
                    
                    if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
                    if (fs.existsSync(saved_track.file_path)) { try { fs.unlinkSync(saved_track.file_path); } catch(e){} }
                    
                    currently_playing = false;
                    current_track_info = null;
                    
                    // نفتح اللوب هنا عشان يكمل باقي الكيو لو فيه أغاني تانية متسيفة
                    playback_loop();
                })();
                return;
            }
        } catch (e) {
            console.error(chalk.red("[RECOVERY ERROR] Cannot parse current_song.json"), e);
        }
    }

    if (song_queue.length > 0 && !play_task) {
        play_event = true;
        play_task = true;
        playback_loop();
    } else {
        check_and_start_autoplay_timer();
    }
});

bot.on('chatCreate', async (user, message) => {
    logWithTime(chalk.yellow, `[CHAT] @${user.username}: ${message}`);
    const lowerMessage = message.toLowerCase().trim();

    if (lowerMessage.startsWith("/play ") || lowerMessage.startsWith("/p ")) {
        const offset = lowerMessage.startsWith("/play ") ? 6 : 3;
        const songQuery = message.substring(offset).trim();

        if (!songQuery) return;

        playback_generation++; 
        is_searching = true;
        
        if (is_autoplay_active === true) {
            logWithTime(chalk.yellow, `[AUTOPLAY] Interrupting autoplay to prioritize @${user.username}`);
            interrupt_autoplay();
        }

        await bot.message.send(`🔍 Searching for @${user.username}... [ ${songQuery} ]`);

        const metaArgs = ['--dump-json', `ytsearch1:${songQuery}`];
        const env = { ...process.env };
        delete env.NODE_CHANNEL_FD; delete env.NODE_UNIQUE_ID; delete env.NODE_OPTIONS;

        let metaDataStr = '';
        const ytMeta = spawn('yt-dlp', metaArgs, { env });
        
        ytMeta.stdout.on('data', (data) => { metaDataStr += data.toString(); });
        ytMeta.on('close', async () => {
            let finalTitle = songQuery;
            let finalDuration = 180;

            try {
                const parsed = JSON.parse(metaDataStr);
                finalTitle = parsed.title || finalTitle;
                finalDuration = parsed.duration || finalDuration;
            } catch (e) {}

            const song = { title: finalTitle, owner: user.username, duration: finalDuration };
            song_queue.push(song);
            save_queue();
            is_searching = false;

            await bot.message.send(`✅ Found! Title: \n"${finalTitle}"\n⏱️ Duration: [${format_time(finalDuration)}]\n🔢 Queue Position: #${song_queue.length}\n👤 Requested by: @${user.username}`);

            play_event = true;
            if (!play_task) {
                play_task = true;
                playback_loop();
            }
        });
    }
    
    else if (lowerMessage === "/q" || lowerMessage === "/queue") {
        if (song_queue.length === 0) {
            await bot.message.send("The music queue is currently empty.");
            return;
        }
        
        let queue_message = `Current Queue (${song_queue.length} songs):\n\n`;
        song_queue.slice(0, 5).forEach((song, idx) => {
            // لو اسم الأغنية أطول من 35 حرف، بنقصه عشان الرسالة كلها متعديش الـ 256 حرف
            const cleanTitle = song.title.length > 35 ? song.title.substring(0, 35) + "..." : song.title;
            
            queue_message += `${idx + 1} - 🔽\n"${cleanTitle}"\n👤 Req by: @${song.owner}\n\n`;
        });
        
        if (song_queue.length > 5) {
            queue_message += `... and ${song_queue.length - 5} more tracks.`;
        }
        
        await bot.message.send(queue_message);
    }

    else if (lowerMessage === "/np") {
        if (!currently_playing || !current_track_info) {
            await bot.message.send("No song is currently playing right now.");
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
        await bot.message.send(`🎵 Now Playing: \n"${current_track_info.title}"\n${progress_bar}\n⏱️ Time: [${format_time(current_elapsed)} / ${format_time(total_duration)}]\n👤 Requested by: ${display_owner}`);
    }
    
    else if (lowerMessage === "/skip") {
        if (!currently_playing || !current_track_info) {
            await bot.message.send("There is no song playing to skip.");
            return;
        }
        
        const display_owner = is_autoplay_active ? "System (Auto-Play)" : `@${current_track_info.owner}`;
        await bot.message.send(`⏭️ Skipped: \n"${current_track_info.title}"\n👤 Skipped by: @${user.username}\n📥 Originally requested by: ${display_owner}`);
        
        clearInterval(progress_interval);

        ffmpeg_stop_promise = stop_current_ffmpeg({ timeoutMs: 1500 });

        if (encode_process) {
            try { encode_process.kill(); } catch (e) {}
        }

        // مسح ملف الـ Recovery عند عمل سكيب صريح حتى لا يعيد تشغيلها البوت بالخطأ
        if (fs.existsSync(current_song_file)) { try { fs.unlinkSync(current_song_file); } catch(e){} }
        
        currently_playing = false;
        current_track_info = null;
        playback_generation++;
    }

    else if (lowerMessage === "/clearq") {
        if (user.username.toLowerCase() === config.owner.toLowerCase()) {
            song_queue = [];
            save_queue();
            await bot.message.send("Music queue has been cleared completely.");
            if (!currently_playing) check_and_start_autoplay_timer();
        } else {
            await bot.message.send("Only the bot owner can clear the queue.");
        }
    }
    
    else if (lowerMessage === "/del") {
        let idx = song_queue.findIndex(s => s.owner === user.username);
        if (idx !== -1) {
            const removed = song_queue.splice(idx, 1);
            save_queue();
            await bot.message.send(`Removed your song: "${removed[0].title}" from the queue.`);
            if (song_queue.length === 0 && !currently_playing) check_and_start_autoplay_timer();
        } else {
            await bot.message.send("You don't have any songs in the queue to remove.");
        }
    }
});

bot.on('error', (error) => {
    console.error(chalk.red(`[Highrise Error]:`), error);
});

bot.login(config.token, config.room_id);