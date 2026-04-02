/* eslint-disable @typescript-eslint/ban-ts-comment */
/*
 * SPDX-FileCopyrightText: 2025 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useState, useEffect, useCallback, useMemo } from 'react';

import { filter } from 'lodash';

const useMediaDevices = (
	deviceType: 'audio' | 'video'
): {
	permission?: PermissionState;
	deviceList: MediaDeviceInfo[];
	noDevices: boolean;
} => {
	const [deviceList, setDeviceList] = useState<MediaDeviceInfo[]>([]);
	const [permissionStatus, setPermissionStatus] = useState<PermissionState | undefined>(undefined);

	const updateDevices = useCallback(() => {
		const deviceKind = deviceType === 'audio' ? 'audioinput' : 'videoinput';
		navigator.mediaDevices
			.enumerateDevices()
			.then((devices) => {
				const inputs = filter(devices, (device: MediaDeviceInfo) => device.kind === deviceKind);
				setDeviceList(inputs);
			})
			.catch((e) => {
				console.log(e);
			});
	}, [deviceType]);

	useEffect(() => {
		if (permissionStatus === 'granted') {
			updateDevices();
		}
	}, [updateDevices, permissionStatus]);

	useEffect(() => {
		navigator.mediaDevices.addEventListener('devicechange', updateDevices);
		return (): void => {
			navigator.mediaDevices.removeEventListener('devicechange', updateDevices);
		};
	}, [updateDevices]);

	const getUserMedia = useCallback(() => {
		navigator.mediaDevices
			.getUserMedia({
				audio: deviceType === 'audio',
				video: deviceType === 'video'
			})
			.then((stream) => {
				stream.getTracks().forEach((track) => track.stop());
				setPermissionStatus('granted');
			})
			.catch(() => {
				setPermissionStatus('denied');
			});
	}, [deviceType]);

	useEffect(() => {
		if (permissionStatus === 'prompt') {
			getUserMedia();
		}
	}, [permissionStatus, getUserMedia]);

	useEffect(() => {
		const deviceKind = deviceType === 'audio' ? 'audioinput' : 'videoinput';
		const permissionName = deviceType === 'audio' ? 'microphone' : 'camera';

		// Enumerate devices first: if any device already has a label, the user has previously
		// granted permission. This is the recommended cross-browser detection approach
		// (https://www.webrtc-developers.com/managing-devices-in-webrtc/) because
		// labels are only populated after permission is granted, even on Firefox.
		navigator.mediaDevices
			.enumerateDevices()
			.then((devices) => {
				const inputs = filter(devices, (device: MediaDeviceInfo) => device.kind === deviceKind);

				if (inputs.some((device) => device.label !== '')) {
					// Labels present: permission was already granted in a prior session.
					setDeviceList(inputs);
					setPermissionStatus('granted');
					return;
				}

				// No labels yet — need to determine the current permission state.
				// Try the Permissions API first (Chrome, Edge, Firefox 120+).
				if (navigator.permissions) {
					navigator.permissions
						.query({ name: permissionName as PermissionName })
						.then((state) => {
							setPermissionStatus(state.state);
							// eslint-disable-next-line no-param-reassign
							state.onchange = (event: Event): void => {
								// @ts-ignore
								const permissionState = event.target?.state as PermissionState;
								setPermissionStatus(permissionState);
							};
						})
						.catch(() => {
							// Permissions API is unsupported for this device type — fall back
							// to getUserMedia() to trigger the browser permission prompt.
							getUserMedia();
						});
				} else {
					// No Permissions API support — trigger the browser permission prompt.
					getUserMedia();
				}
			})
			.catch(() => {
				// enumerateDevices() failed — fall back to getUserMedia().
				getUserMedia();
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const noDevices = useMemo(() => deviceList.length === 0, [deviceList]);

	return {
		deviceList,
		permission: permissionStatus,
		noDevices
	};
};

export default useMediaDevices;
