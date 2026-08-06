const JSON_HEADERS = { Accept: 'application/json' };

function escapeAttribute(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function decodeAddress(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_) {
        return '';
    }
}

function previewImageForNode(node) {
    if (typeof node.shareImage === 'string' && node.shareImage) return node.shareImage;
    if (typeof node.previewImage === 'string' && node.previewImage) return node.previewImage;
    if (typeof node.video?.poster === 'string' && node.video.poster) return node.video.poster;

    if (Array.isArray(node.images) && node.images.length) {
        const first = node.images[0];
        if (typeof first === 'string') return first;
        if (typeof first?.src === 'string') return first.src;
    }

    if (Array.isArray(node.visuals)) {
        for (const visual of node.visuals) {
            if (typeof visual?.poster === 'string' && visual.poster) return visual.poster;
            if (visual?.type === 'image' && typeof visual.src === 'string' && visual.src) return visual.src;
            if (visual?.type === 'image_bundle' && Array.isArray(visual.files) && visual.files.length) {
                return visual.files[0];
            }
        }
    }

    return '';
}

function absoluteMediaUrl(path, manifest, requestUrl) {
    if (!path) return '';
    try {
        return new URL(path).href;
    } catch (_) {
        const mediaBase = String(manifest?.terrain?.mediaBase || '').replace(/\/$/, '');
        if (mediaBase) return `${mediaBase}/${String(path).replace(/^\//, '')}`;
        return new URL(path, requestUrl).href;
    }
}

function injectPreviewMetadata(html, metadata) {
    const title = escapeAttribute(metadata.title);
    const description = escapeAttribute(metadata.description);
    const image = escapeAttribute(metadata.image);
    const url = escapeAttribute(metadata.url);
    const siteName = escapeAttribute(metadata.siteName);
    const imageTags = image ? `
    <meta property="og:image" content="${image}">
    <meta property="og:image:alt" content="${title}">
    <meta name="twitter:image" content="${image}">` : '';
    const tags = `
    <!-- Terrain node link preview -->
    <meta name="description" content="${description}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${siteName}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${url}">${imageTags}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <link rel="canonical" href="${url}">
    `;
    const withoutDefaultPreview = html.replace(
        /\s*<!-- Terrain default link preview:start -->[\s\S]*?<!-- Terrain default link preview:end -->\s*/,
        '\n'
    );
    return withoutDefaultPreview.replace('</head>', `${tags}</head>`);
}

async function assetResponse(context, path, headers) {
    const url = new URL(path, context.request.url);
    const request = new Request(url, headers ? { headers } : undefined);
    if (context.env?.ASSETS?.fetch) return context.env.ASSETS.fetch(request);
    return fetch(request);
}

export async function onRequest(context) {
    if (!['GET', 'HEAD'].includes(context.request.method)) {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const address = decodeAddress(context.params.address);
    if (!address) return new Response('Node not found', { status: 404 });

    try {
        const [indexResponse, manifestResponse, configResponse] = await Promise.all([
            assetResponse(context, '/index.html'),
            assetResponse(context, '/manifest.json', JSON_HEADERS),
            assetResponse(context, '/site-config.json', JSON_HEADERS)
        ]);
        if (!indexResponse.ok || !manifestResponse.ok) {
            throw new Error('Terrain assets are unavailable');
        }

        const [html, manifest, siteConfig] = await Promise.all([
            indexResponse.text(),
            manifestResponse.json(),
            configResponse.ok ? configResponse.json() : Promise.resolve({})
        ]);

        if ((manifest?.terrain?.mode || siteConfig?.mode || 'public') !== 'public') {
            return new Response('Node not found', { status: 404 });
        }

        const node = manifest?.nodes?.find(candidate => candidate.id === address);
        if (!node || node.addressable === false || node.shareable === false) {
            return new Response('Node not found', { status: 404 });
        }

        const requestUrl = new URL(context.request.url);
        requestUrl.search = '';
        requestUrl.hash = '';
        const terrainTitle = manifest.terrain?.title || siteConfig?.title || 'Terrain';
        const nodeTitle = node.title || `Node ${node.id}`;
        const description = node.shareDescription || node.description || `A node from ${terrainTitle}.`;
        const fallbackImage = siteConfig?.startImage || '';
        const image = absoluteMediaUrl(previewImageForNode(node) || fallbackImage, manifest, requestUrl);
        const output = injectPreviewMetadata(html, {
            title: nodeTitle,
            description,
            image,
            url: requestUrl.href,
            siteName: terrainTitle
        });
        const headers = new Headers(indexResponse.headers);
        headers.set('Content-Type', 'text/html; charset=UTF-8');
        headers.set('Cache-Control', 'public, max-age=300');
        headers.set('Vary', 'Accept-Encoding');
        return new Response(context.request.method === 'HEAD' ? null : output, { status: 200, headers });
    } catch (error) {
        console.error('Terrain node preview failed:', error);
        return new Response('Unable to load Terrain node', { status: 500 });
    }
}

export const TerrainNodePreview = {
    absoluteMediaUrl,
    decodeAddress,
    injectPreviewMetadata,
    previewImageForNode
};
