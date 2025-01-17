const Apify = require('apify');

const { log } = Apify.utils;

Apify.main(async () => {
    // Initialize
    const input = await Apify.getInput();
    const dataset = await Apify.openDataset();
    const requestQueue = await Apify.openRequestQueue();

    // Check input
    const sOk = input.search && input.search.trim().length > 0;
    const lOk = input.location && input.location.trim().length > 0;

    if ((!sOk || !lOk) && !input.startUrls) {
        throw new Error(
            'Either "search" and "location" attributes or "startUrls" attribute has to be set!',
        );
    }

    // Add URLs to requestQueue
    if (input.search && input.location) {
        const term = encodeURIComponent(input.search.trim());
        const loc = encodeURIComponent(input.location.trim());
        await requestQueue.addRequest({
            url: `https://www.pagesjaunes.fr/annuaire/chercherlespros?quoiqui=${term}&ou=${loc}&univers=pagesjaunes&idOu=`,
        });
    }

    if (input.startUrls) {
        for (const sUrl of input.startUrls) {
            const request = typeof sUrl === 'string' ? { url: sUrl } : sUrl;
            if (!request.url || typeof request.url !== 'string') {
                throw new Error(`Invalid startUrl: ${JSON.stringify(sUrl)}`);
            }
            await requestQueue.addRequest(request);
        }
    }

    // Parse extendOutputFunction
    let extendOutputFunction = null;

    if (input.extendOutputFunction) {
        try {
            extendOutputFunction = eval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(
                `extendOutputFunction is not a valid JavaScript! Error: ${e}`,
            );
        }

        if (typeof extendOutputFunction !== 'function') {
            throw new Error(
                `extendOutputFunction is not a function! Please fix it or use just default output!`,
            );
        }
    }

    // Parse rating value from element class
    const nums = ['one', 'two', 'three', 'four', 'five'];
    const parseRating = (aClass) => {
        for (let i = 0; i < nums.length; i++) {
            if (aClass.includes(nums[i])) {
                return aClass.includes('half') ? i + 1.5 : i + 1;
            }
        }
        return undefined;
    };

    const proxyConfiguration = await Apify.createProxyConfiguration(input.proxyConfiguration);

    // Create and run crawler
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        proxyConfiguration,
        handlePageFunction: async ({
            request,
            $,
        }) => {
            const { url } = request;

            // Process result list
            const results = [];
            const resultElems = $('.bi-list > li');

            for (const r of resultElems.toArray()) {
                const jThis = $(r);
                const getText = (selector) => {
                    const text = jThis.find(selector).text().trim();
                    return text.length > 0 ? text : undefined;
                };
                const businessSlug = atob(JSON.parse(jThis.find('a.bi-denomination').attr('data-pjlb')).url);
                const address = getText('.bi-address a')
                    || jThis
                        .find('.bi-address')
                        .nextUntil('p')
                        .toArray()
                        .map((l) => $(l).text().trim())
                        .join(', ');
                const categories = jThis
                    .find('.bi-tags-list li')
                    .toArray()
                    .map((c) => $(c).text().trim());
                const rating = getText(jThis.find('.bi-note h4'));
                const rCount = getText('.bi-rating');
                const website = jThis
                    .find('a.track-visit-website')
                    .attr('href');
                const reviewSnippet = getText('.snippet');
                const isInfoSnippet = reviewSnippet && reviewSnippet.includes('From Business');
                const image = jThis.find('a.photo img').attr('src');
                const result = {
                    isAd: getText('.ad-pill') === 'Ad' || undefined,
                    url: businessSlug ? `https://www.pagesjaunes.fr${businessSlug}` : undefined,
                    name: getText('h3'),
                    address: address.length > 0 ? address : undefined,
                    phone: getText('.number-contact span:last'),
                    website,
                    rating: rating ? parseRating(rating) : undefined,
                    ratingCount: rCount
                        ? parseFloat(rCount.match(/\d+/)[0])
                        : undefined,
                    reviewSnippet: isInfoSnippet ? undefined : reviewSnippet,
                    infoSnippet: isInfoSnippet
                        ? reviewSnippet.slice(15)
                        : undefined,
                    image: image ? image.split('_')[0] : undefined,
                    categories: categories.length > 0 ? categories : undefined,
                };

                if (extendOutputFunction) {
                    try {
                        Object.assign(
                            result,
                            await extendOutputFunction($, jThis),
                        );
                    } catch (e) {
                        log.exception(e, 'extendOutputFunction error:');
                    }
                }

                results.push(result);
            }

            // Check maximum result count
            if (input.maxItems) {
                const count = (await dataset.getInfo()).cleanItemCount;
                if (count + results.length >= input.maxItems) {
                    const allowed = input.maxItems - count;
                    if (allowed > 0) {
                        await dataset.pushData(results.slice(0, allowed));
                    }
                    return process.exit(0);
                }
            }

            log.info(`Found ${results.length} results.`, { url });

            // Store results and enqueue next page
            await dataset.pushData(results);

            const nextInfos = $('.pagination .next').attr('data-pjlb');
            var nextUrl = null;
            if (nextInfos){
                nextUrl = atob(JSON.parse(nextInfos).url);
                
            }


            if (nextUrl) {
                const nextPageReq = await requestQueue.addRequest({
                    url: `https://www.pagesjaunes.fr${nextUrl}`,
                });

                if (!nextPageReq.wasAlreadyPresent) {
                    log.info('Found next page, adding to queue...', { url });
                }
            } else {
                log.info('No next page found', { url });
            }
        },
    });
    await crawler.run();
});
