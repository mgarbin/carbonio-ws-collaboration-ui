/*
 * SPDX-FileCopyrightText: 2025 Zextras <https://www.zextras.com>
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type DeviceGroup = {
	audio?: MediaDeviceInfo;
	video?: MediaDeviceInfo;
};

type UseGroupedMediaDevicesReturn = {
	groups: Map<string, DeviceGroup>;
	newGroups: Map<string, DeviceGroup>;
};

const buildGroups = (devices: MediaDeviceInfo[]): Map<string, DeviceGroup> => {
	const groups = new Map<string, DeviceGroup>();
	devices.forEach((device) => {
		if (device.kind !== 'audioinput' && device.kind !== 'videoinput') return;
		const existing = groups.get(device.groupId) ?? {};
		if (device.kind === 'audioinput') {
			groups.set(device.groupId, { ...existing, audio: device });
		} else {
			groups.set(device.groupId, { ...existing, video: device });
		}
	});
	return groups;
};

const useGroupedMediaDevices = (): UseGroupedMediaDevicesReturn => {
	const [groups, setGroups] = useState<Map<string, DeviceGroup>>(new Map());
	const [newGroups, setNewGroups] = useState<Map<string, DeviceGroup>>(new Map());
	const prevGroupIdsRef = useRef<Set<string>>(new Set());

	const updateGroups = useCallback(() => {
		navigator.mediaDevices
			.enumerateDevices()
			.then((devices) => {
				const nextGroups = buildGroups(devices);
				prevGroupIdsRef.current = new Set(nextGroups.keys());
				setGroups(nextGroups);
			})
			.catch((e) => {
				console.log(e);
			});
	}, []);

	const onDeviceChange = useCallback(() => {
		navigator.mediaDevices
			.enumerateDevices()
			.then((devices) => {
				const nextGroups = buildGroups(devices);
				const added = new Map<string, DeviceGroup>();
				nextGroups.forEach((group, id) => {
					if (!prevGroupIdsRef.current.has(id)) {
						added.set(id, group);
					}
				});
				setNewGroups(added);
				prevGroupIdsRef.current = new Set(nextGroups.keys());
				setGroups(nextGroups);
			})
			.catch((e) => {
				console.log(e);
			});
	}, []);

	useEffect(() => {
		updateGroups();
	}, [updateGroups]);

	useEffect(() => {
		navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
		return (): void => {
			navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
		};
	}, [onDeviceChange]);

	return { groups, newGroups };
};

export default useGroupedMediaDevices;
