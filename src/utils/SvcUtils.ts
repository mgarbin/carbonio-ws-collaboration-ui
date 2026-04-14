/*
 * SPDX-FileCopyrightText: 2026 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * scalabilityMode string used for camera video streams.
 * L3T3 = 3 spatial layers × 3 temporal layers (VP9/AV1 SVC).
 */
export const VIDEO_SVC_MODE = 'L3T3';

/**
 * scalabilityMode string used for screen-share streams.
 * L1T2KEY = 1 spatial layer × 2 temporal layers with periodic key-frames,
 * which works well for screen content while still letting the SFU forward
 * a lower temporal layer when bandwidth is constrained.
 */
export const SCREEN_SVC_MODE = 'L1T2KEY';

/**
 * RTCRtpCodec extended with the scalabilityModes field defined in
 * the WebRTC SVC extension (not yet in all TypeScript DOM lib versions).
 */
type RTCRtpCodecWithSvc = RTCRtpCodec & {
	scalabilityModes?: string[];
};

/**
 * Returns true when the browser's VP9 or AV1 encoder advertises support for
 * the requested scalabilityMode string via the static
 * RTCRtpSender.getCapabilities('video') API.
 *
 * Browsers that do NOT support this API (Firefox, Safari) or that do not list
 * the requested mode return false, causing callers to fall back to the legacy
 * single-encoding path.
 *
 * @param scalabilityMode - e.g. 'L3T3' or 'L1T2KEY'
 */
export const isSvcSupported = (scalabilityMode: string): boolean => {
	if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
		return false;
	}
	const caps = RTCRtpSender.getCapabilities('video');
	if (!caps) return false;
	return (caps.codecs as RTCRtpCodecWithSvc[]).some(
		(codec) =>
			(codec.mimeType === 'video/VP9' || codec.mimeType === 'video/AV1') &&
			Array.isArray(codec.scalabilityModes) &&
			codec.scalabilityModes.includes(scalabilityMode)
	);
};
