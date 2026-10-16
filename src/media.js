const {
    downloadMediaMessage,
    normalizeMessageContent,
    getContentType
} = require('@whiskeysockets/baileys');
const sharp = require('sharp');
const pino = require('pino');
const { db } = require('./firebase');

const logger = pino({ level: 'silent' });

// --- MEDIA CAPTURE ---
// Media lives in its own top-level `Media` collection (NOT under Messages),
// so warmCache()'s collectionGroup('Messages') never pulls file bytes into RAM.
// Bytes are stored as a Firestore Bytes field; one doc is capped at 1 MiB,
// so anything larger than MAX_BYTES after compression is kept as a label only.
const MAX_BYTES = 900 * 1024;

const MEDIA_KINDS = {
    imageMessage:    { type: 'image',    label: '📷 Photo' },
    videoMessage:    { type: 'video',    label: '🎥 Video' },
    ptvMessage:      { type: 'video',    label: '🎥 Video note' },
    audioMessage:    { type: 'audio',    label: '🎵 Audio' },
    stickerMessage:  { type: 'sticker',  label: '💟 Sticker' },
    documentMessage: { type: 'document', label: '📄 Document' }
};

const mediaDocId = (chatId, msgId) => `${chatId}__${msgId}`;

// Unwraps ephemeral / view-once / document-with-caption wrappers and
// returns { content, contentType, kind } or null for non-media messages.
function getMediaInfo(message) {
    const content = normalizeMessageContent(message);
    if (!content) return null;
    const contentType = getContentType(content);
    const kind = MEDIA_KINDS[contentType];
    if (!kind) return null;

    const media = content[contentType];
    let label = kind.label;
    if (contentType === 'audioMessage' && media.ptt) label = '🎤 Voice message';
    if (kind.type === 'document' && media.fileName) label = `📄 ${media.fileName}`;

    return { content, contentType, media, type: kind.type, label, caption: media.caption || '' };
}

async function compressImage(buffer) {
    for (const [size, quality] of [[1600, 75], [1280, 65], [960, 55]]) {
        const out = await sharp(buffer).rotate()
            .resize(size, size, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality, mozjpeg: true })
            .toBuffer();
        if (out.length <= MAX_BYTES) return out;
    }
    return null;
}

async function compressSticker(buffer) {
    try {
        const out = await sharp(buffer, { animated: true })
            .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 70 })
            .toBuffer();
        return out.length <= MAX_BYTES ? out : null;
    } catch (e) {
        return buffer.length <= MAX_BYTES ? buffer : null;
    }
}

// Downloads, compresses and stores the media for one message.
// Returns { stored, size } — never throws.
async function saveMedia(sock, msg, info, chatId) {
    const { media, type } = info;
    const doc = {
        chatId,
        msgId: msg.key.id,
        type,
        mimetype: media.mimetype || null,
        fileName: media.fileName || null,
        seconds: media.seconds || null,
        createdAt: Date.now()
    };

    if (media.jpegThumbnail && media.jpegThumbnail.length) {
        doc.thumb = Buffer.from(media.jpegThumbnail);
    }

    let data = null;
    const declaredSize = Number(media.fileLength || 0);
    // Skip huge downloads outright (e.g. long videos) — we couldn't store them anyway.
    const worthDownloading = type === 'image' || type === 'sticker' || !declaredSize || declaredSize <= MAX_BYTES;

    if (worthDownloading) {
        try {
            const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                { logger, reuploadRequest: sock.updateMediaMessage }
            );

            if (type === 'image') {
                data = await compressImage(buffer);
                if (data) doc.mimetype = 'image/jpeg';
            } else if (type === 'sticker') {
                data = await compressSticker(buffer);
                if (data) doc.mimetype = 'image/webp';
            } else if (buffer.length <= MAX_BYTES) {
                data = buffer;
            }
        } catch (err) {
            console.error(`Media: download failed for ${info.contentType} in ${chatId}: ${err.message}`);
        }
    }

    if (data) doc.data = data;
    if (!data && !doc.thumb) return { stored: false, thumb: false };

    try {
        await db.collection('Media').doc(mediaDocId(chatId, msg.key.id)).set(doc);
        return { stored: !!data, thumb: !!doc.thumb, size: data ? data.length : 0 };
    } catch (err) {
        console.error(`Media: Firestore write failed for ${chatId}: ${err.message}`);
        return { stored: false, thumb: false };
    }
}

module.exports = { getMediaInfo, saveMedia, mediaDocId };
