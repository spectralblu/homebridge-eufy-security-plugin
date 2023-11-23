import { Station, Device } from '@spectralblu/eufy-security-client';

export interface DeviceIdentifier {
    uniqueId: string;
    displayName: string;
    type: number;
    station: boolean;
}

export interface DeviceContainer {
    deviceIdentifier: DeviceIdentifier;
    eufyDevice: Device | Station;
}
