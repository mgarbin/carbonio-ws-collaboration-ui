/*
 * SPDX-FileCopyrightText: 2026 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { VIDEO_SVC_MODE, SCREEN_SVC_MODE, isSvcSupported } from './SvcUtils';

const defineRTCRtpSender = (value: unknown): void => {
	Object.defineProperty(globalThis, 'RTCRtpSender', { value, writable: true, configurable: true });
};

afterEach(() => {
	// restore RTCRtpSender to undefined between tests
	defineRTCRtpSender(undefined);
});

describe('SvcUtils constants', () => {
	test('VIDEO_SVC_MODE is L3T3', () => {
		expect(VIDEO_SVC_MODE).toBe('L3T3');
	});

	test('SCREEN_SVC_MODE is L1T2KEY', () => {
		expect(SCREEN_SVC_MODE).toBe('L1T2KEY');
	});
});

describe('isSvcSupported', () => {
	test('returns false when RTCRtpSender is undefined', () => {
		defineRTCRtpSender(undefined);
		expect(isSvcSupported('L3T3')).toBe(false);
	});

	test('returns false when RTCRtpSender has no getCapabilities method', () => {
		defineRTCRtpSender({});
		expect(isSvcSupported('L3T3')).toBe(false);
	});

	test('returns false when getCapabilities returns null', () => {
		defineRTCRtpSender({ getCapabilities: () => null });
		expect(isSvcSupported('L3T3')).toBe(false);
	});

	test('returns false when no codec advertises the requested mode', () => {
		defineRTCRtpSender({
			getCapabilities: () => ({
				codecs: [
					{ mimeType: 'video/VP8', scalabilityModes: undefined },
					{ mimeType: 'video/H264', scalabilityModes: ['L1T1'] }
				]
			})
		});
		expect(isSvcSupported('L3T3')).toBe(false);
	});

	test('returns false when VP9 is present but scalabilityModes is missing', () => {
		defineRTCRtpSender({
			getCapabilities: () => ({
				codecs: [{ mimeType: 'video/VP9' }]
			})
		});
		expect(isSvcSupported('L3T3')).toBe(false);
	});

	test('returns false when VP9 scalabilityModes does not include the requested mode', () => {
		defineRTCRtpSender({
			getCapabilities: () => ({
				codecs: [{ mimeType: 'video/VP9', scalabilityModes: ['L1T1', 'L1T2'] }]
			})
		});
		expect(isSvcSupported('L3T3')).toBe(false);
	});

	test('returns true when VP9 codec includes the requested mode', () => {
		defineRTCRtpSender({
			getCapabilities: () => ({
				codecs: [
					{ mimeType: 'video/VP8', scalabilityModes: [] },
					{ mimeType: 'video/VP9', scalabilityModes: ['L1T1', 'L2T2', 'L3T3'] }
				]
			})
		});
		expect(isSvcSupported('L3T3')).toBe(true);
	});

	test('returns true when AV1 codec includes the requested mode', () => {
		defineRTCRtpSender({
			getCapabilities: () => ({
				codecs: [{ mimeType: 'video/AV1', scalabilityModes: ['L1T1', 'L3T3', 'L3T3_KEY'] }]
			})
		});
		expect(isSvcSupported('L3T3')).toBe(true);
	});

	test('returns true when VP9 supports L1T2KEY (screen mode)', () => {
		defineRTCRtpSender({
			getCapabilities: () => ({
				codecs: [{ mimeType: 'video/VP9', scalabilityModes: ['L1T1', 'L1T2KEY'] }]
			})
		});
		expect(isSvcSupported('L1T2KEY')).toBe(true);
	});
});
