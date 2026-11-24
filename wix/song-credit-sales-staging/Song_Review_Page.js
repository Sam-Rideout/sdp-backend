import wixLocationFrontend from 'wix-location-frontend';
import { session } from 'wix-storage-frontend';
import wixPayFrontend from 'wix-pay-frontend';
import {
    loadSongCategories,
    getSongCategory
} from 'public/songCategories';
import {
    listSongReviews,
    getSongReview,
    getSongJourney,
    approveWithCredit,
    createSongCheckout,
    refreshPurchasedPlan,
    listMySongPlans,
    cancelMySongPlan,
    createMonthlySongCheckout,
    createSongCreditBundleCheckout,
    refreshSongCreditBalance
} from 'backend/songReview.web';
import {
    approveWithPromotion,
    withdrawTester
} from 'backend/tester.web';
const PRODUCTS = [
    'VOICE_CLONE',
    'ORIGINAL_MESSAGE',
    'ORIGINAL_ONLY'
];
$w.onReady(function () {
    let selected = '';
    let busy = false;
    let plans = {};
    let bundles = {};
    let navigating = false;
    let pollingPaused = false;
    let viewMode = 'LOADING';
    const frame = $w('#htmlSongReview');
    function openMyOrders() {
        if (navigating) return;
        send({
            type: 'NOTICE',
            message: 'Opening My Orders to view your delivery status…'
        });
        navigating = true;
        try {
            wixLocationFrontend.to('/orders');
        } catch (error) {
            navigating = false;
            throw error;
        }
    }
    function sameApprovedReview(review, reviewId, previewSha256) {
        if (
            review?.review_id !== reviewId ||
            review.preview_sha256 !== previewSha256
        ) {
            throw new Error(
                'Your saved approval could not be verified. Please refresh your orders before trying again.'
            );
        }
        return review.authorized === true || review.state === 'DELIVERED';
    }
    function send(data) {
        frame.postMessage({
            channel: 'PX_SONG_REVIEW',
            ...data
        });
    }
    function occasion() {
        const query = wixLocationFrontend.query.occasion;
        const requested = query !== undefined
            ? query
            : session.getItem('pxOccasion');
        return getSongCategory(requested)?.occasionCode || '';
    }
    function choiceState(mode) {
        viewMode = mode;
        const value = occasion();
        send({
            type: 'MODE',
            mode,
            canChoose: mode === 'CHOOSE' && Boolean(value),
            occasion: value,
            occasionLabel: getSongCategory(value)?.label || ''
        });
    }
    async function refresh() {
        const list = await listSongReviews();
        if (list.available === false) {
            if (list.products) send({type: 'LIST', data: {...list, credits: 0}});
            selected = '';
            plans = {};
            const journey = await getSongJourney();
            if (journey.hasPendingRequest) {
                choiceState('WAITING');
                send({
                    type: 'EMPTY',
                    message: journey.message
                });
            } else {
                choiceState('CHOOSE');
                send({
                    type: 'UNAVAILABLE',
                    message:
                        'You can choose a product and browse songs. ' +
                        'Song review and checkout are not available yet.'
                });
            }
            return;
        }
        plans = list.plans || {};
        bundles = list.bundles || {};
        send({
            type: 'LIST',
            data: list
        });
        // A delivered song can disappear from pending reviews between polls.
        // Keep this review's customer on their order, rather than the product chooser.
        const previous = list.reviews.find(review => review.review_id === selected);
        if (previous && (previous.authorized === true || previous.state === 'DELIVERED')) {
            openMyOrders();
            return;
        }
        const pending = list.reviews.filter(
            review => review.state !== 'DELIVERED'
        );
        if (pending.length > 1) {
            selected = '';
            choiceState('WAITING');
            send({
                type: 'EMPTY',
                message:
                    'Your saved requests need Project X review. ' +
                    'Please return to My Orders.'
            });
            return;
        }
        if (pending.length === 1) {
            selected = pending[0].review_id;
            choiceState('REVIEW');
            const review = await getSongReview(selected);
            if (review.review_id !== selected) {
                throw new Error(
                    'Your song could not be verified. Please refresh the page.'
                );
            }
            if (review.authorized === true || review.state === 'DELIVERED') {
                openMyOrders();
                return;
            }
            send({
                type: 'REVIEW',
                data: review
            });
            return;
        }
        const journey = await getSongJourney();
        selected = '';
        if (journey.hasPendingRequest) {
            choiceState('WAITING');
            send({
                type: 'EMPTY',
                message: journey.message
            });
            return;
        }
        choiceState('CHOOSE');
        send({
            type: 'CHOOSE',
            message: occasion()
                ? (
                    list.tester?.active
                        ? 'Choose your free promotional song. Listen to the finished preview, then approve it for email delivery.'
                        : 'Choose the product you want. You will pay for the song only after listening and approving it.'
                )
                : 'Choose your occasion first, then choose your song product.'
        });
    }
    frame.onMessage(async event => {
        const message = event.data;
        if (
            message?.channel !== 'PX_SONG_REVIEW' ||
            busy
        ) {
            return;
        }
        const allowed = [
            'READY',
            'REFRESH',
            'CHOOSE_PRODUCT',
            'CREDIT',
            'PAY',
            'PLAN',
            'BUNDLE',
            'CANCEL_PLAN',
            'MY_PLANS',
            'PROMOTION',
            'TESTER_WITHDRAW'
        ];
        if (!allowed.includes(message.type)) {
            return;
        }
        busy = true;
        send({
            type: 'BUSY',
            value: true
        });
        let stage = 'loading categories';
        try {
            await loadSongCategories();
            stage = 'handling ' + message.type;
            if (message.type === 'CHOOSE_PRODUCT') {
                if (!PRODUCTS.includes(message.productType)) {
                    throw new Error(
                        'Choose one of the three song products.'
                    );
                }
                const value = occasion();
                if (!value) {
                    throw new Error(
                        'Choose your occasion first using the Choose Occasion link.'
                    );
                }
                const list = await listSongReviews();
                const journey = await getSongJourney();
                const pendingReview =
                    list.available !== false &&
                    list.reviews.some(
                        review => review.state !== 'DELIVERED'
                    );
                if (pendingReview || journey.hasPendingRequest) {
                    await refresh();
                    return;
                }
                session.setItem('pxOccasion', value);
                session.setItem(
                    'pxProductType',
                    message.productType
                );
                wixLocationFrontend.to(
                    `/genre-selection?product=${encodeURIComponent(message.productType)}` +
                    `&occasion=${encodeURIComponent(value)}`
                );
                navigating = true;
            } else if (message.type === 'TESTER_WITHDRAW') {
                await withdrawTester();
                await refresh();
            } else if (message.type === 'MY_PLANS') {
                send({
                    type: 'MY_PLANS',
                    data: await listMySongPlans()
                });
            } else if (message.type === 'CANCEL_PLAN') {
                const result = await cancelMySongPlan(
                    message.orderId
                );
                send({
                    type: 'NOTICE',
                    message: result.message
                });
                send({
                    type: 'MY_PLANS',
                    data: await listMySongPlans()
                });
                await refresh();
            } else if (
                message.type === 'CREDIT' ||
                message.type === 'PAY' ||
                message.type === 'PROMOTION'
            ) {
                if (
                    !selected ||
                    message.reviewId !== selected ||
                    message.approved !== true
                ) {
                    throw new Error(
                        'Listen to the song and confirm your approval first.'
                    );
                }
                if (message.type === 'PROMOTION') {
                    await approveWithPromotion(
                        selected,
                        message.previewSha256
                    );
                } else if (message.type === 'CREDIT') {
                    await approveWithCredit(
                        selected,
                        message.previewSha256
                    );
                } else {
                    const payment = await createSongCheckout(
                        selected,
                        message.previewSha256
                    );
                    const result = await wixPayFrontend.startPayment(
                        payment.paymentId,
                        {
                            showThankYouPage: false
                        }
                    );
                    // This result controls navigation only. The existing backend
                    // payment event remains the sole authority to release delivery.
                    if (['Successful', 'Pending'].includes(result?.status)) {
                        openMyOrders();
                        return;
                    }
                    await refresh();
                    if (!navigating) {
                        send({
                            type: 'NOTICE',
                            message: result?.status === 'Cancelled'
                                ? 'Payment was cancelled. Your song is saved here for you to review and pay when ready.'
                                : 'Payment was not completed. Check your payment status before trying again.'
                        });
                    }
                    return;
                }
                const approved = await getSongReview(selected);
                if (sameApprovedReview(approved, selected, message.previewSha256)) {
                    openMyOrders();
                    return;
                }
                choiceState('REVIEW');
                send({type: 'REVIEW', data: approved});
                send({
                    type: 'NOTICE',
                    message: 'Your approval is awaiting confirmation. Refresh your order status before trying again.'
                });
            } else if (message.type === 'BUNDLE') {
                const bundle=bundles[message.bundle];
                if(!bundle || !Number.isSafeInteger(message.expectedAmountMinor) ||
                    message.expectedAmountMinor!==bundle.amountMinor)
                    throw new Error('The bundle price changed. Refresh before continuing.');
                stage='creating one-time credit bundle checkout';
                const purchase=await createSongCreditBundleCheckout(message.bundle,message.expectedAmountMinor);
                if(!purchase?.paymentId)throw new Error('Bundle checkout is awaiting reconciliation. Contact Project X.');
                stage='opening one-time credit bundle payment';
                await wixPayFrontend.startPayment(purchase.paymentId,{showThankYouPage:false});
                const balance=await refreshSongCreditBalance();
                await refresh();
                send({type:'NOTICE',message:'Your confirmed balance is '+balance.credits+' song credits. '+
                    'Payments still being verified appear after confirmation. A song credit is used only when you approve a finished song.'});
            } else if (message.type === 'PLAN') {
                stage = 'checking monthly plan configuration';
                console.info(
                    'Project X monthly checkout: button received',
                    message.plan, message.expectedAmountMinor
                );
                const plan = plans[message.plan];
                if (!plan?.planId) {
                    throw new Error(
                        'Monthly plans are not available yet.'
                    );
                }
                if (!Number.isSafeInteger(message.expectedAmountMinor) ||
                    message.expectedAmountMinor !== plan.amountMinor) {
                    throw new Error('The monthly price changed. Refresh and review the current terms.');
                }
                stage = 'creating monthly checkout';
                console.info(
                    'Project X monthly checkout: requesting checkout',
                    message.plan,
                    plan.planId
                );
                const purchase = await createMonthlySongCheckout(
                    message.plan, message.expectedAmountMinor
                );
                if (
                    !purchase?.paymentId ||
                    !purchase?.orderId
                ) {
                    throw new Error(
                        'Monthly checkout did not return payment details. ' +
                        'Please contact Project X before retrying.'
                    );
                }
                stage = 'opening monthly payment window';
                console.info(
                    'Project X monthly checkout: opening payment window'
                );
                await wixPayFrontend.startPayment(
                    purchase.paymentId,
                    {
                        showThankYouPage: false
                    }
                );
                stage = 'checking monthly payment result';
                console.info(
                    'Project X monthly checkout: payment window closed'
                );
                await refreshPurchasedPlan(purchase.orderId);
                await refresh();
            } else {
                await refresh();
            }
            pollingPaused = false;
        } catch (error) {
            pollingPaused = true;
            const detail =
                error?.message ||
                'Please try again shortly.';
            console.error(
                'Project X Song Review failed:',
                message.type,
                stage,
                detail
            );
            choiceState('ERROR');
            send({
                type: 'ERROR',
                message: detail
            });
        } finally {
            if (!navigating) {
                busy = false;
                send({
                    type: 'BUSY',
                    value: false
                });
            }
        }
    });
    // Poll processing and review screens.
    // Manual refresh or reload can retry a displayed error.
    setInterval(() => {
        if (
            !pollingPaused &&
            !busy &&
            !navigating &&
            ['WAITING', 'REVIEW'].includes(viewMode)
        ) {
            send({
                type: 'POLL'
            });
        }
    }, 10000);
    send({
        type: 'INIT'
    });
});
