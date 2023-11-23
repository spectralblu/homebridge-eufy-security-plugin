import { Characteristic, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { EufySecurityPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Station, DeviceType, PropertyName, PropertyValue, AlarmEvent, GuardMode } from '@spectralblu/eufy-security-client';
import { StationConfig } from '../utils/configTypes';

export enum HKGuardMode {
  STAY_ARM = 0,
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARM = 3
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class StationAccessory extends BaseAccessory {

  private alarm_triggered: boolean;
  private modes;
  public readonly hasKeyPad: boolean = false;

  private alarm_delayed: boolean;
  private alarm_delay_timeout?: NodeJS.Timeout;

  public readonly stationConfig: StationConfig;

  private guardModeChangeTimeout: {
    timeout: NodeJS.Timeout | null;
    delay: number;
  } = { timeout: null, delay: 5000 };

  constructor(
    platform: EufySecurityPlatform,
    accessory: PlatformAccessory,
    device: Station,
  ) {
    super(platform, accessory, device);

    this.platform.log.debug(`${this.accessory.displayName} Constructed Station`);

    this.stationConfig = this.getStationConfig();

    this.hasKeyPad = this.device.hasDeviceWithType(DeviceType.KEYPAD);

    this.mappingHKEufy();

    this.alarm_triggered = false;
    this.alarm_delayed = false;

    const validValues = [
      this.platform.Characteristic.SecuritySystemTargetState.AWAY_ARM,
      this.platform.Characteristic.SecuritySystemTargetState.STAY_ARM,
      this.platform.Characteristic.SecuritySystemTargetState.DISARM,
    ];

    const SecuritySettings = [
      PropertyName.StationHomeSecuritySettings,
      PropertyName.StationAwaySecuritySettings,
      PropertyName.StationOffSecuritySettings,
      PropertyName.StationCustom1SecuritySettings,
      PropertyName.StationCustom2SecuritySettings,
      PropertyName.StationCustom3SecuritySettings,
    ];

    SecuritySettings.forEach(item => {
      if (this.device.hasPropertyValue(item) && this.getPropertyValue(item) !== '') {
        this.platform.log.debug(`${this.accessory.displayName} - ${item} : ${JSON.stringify(this.getPropertyValue(item))}`);
      }
    });

    // if (this.stationConfig.hkNight) {
    validValues.push(this.platform.Characteristic.SecuritySystemTargetState.NIGHT_ARM);
    // }

    this.registerCharacteristic({
      serviceType: this.platform.Service.SecuritySystem,
      characteristicType: this.platform.Characteristic.SecuritySystemCurrentState,
      getValue: (data) => this.handleSecuritySystemCurrentStateGet(),
      onValue: (service, characteristic) => {
        this.device.on('current mode', (station: Station, currentMode: number) => {
          this.onStationCurrentModePushNotification(characteristic, station, currentMode);
        });
        this.device.on('alarm event', (station: Station, alarmEvent: AlarmEvent) =>
          this.onStationAlarmEventPushNotification(characteristic, station, alarmEvent),
        );
      },
    });

    this.registerCharacteristic({
      serviceType: this.platform.Service.SecuritySystem,
      characteristicType: this.platform.Characteristic.SecuritySystemTargetState,
      getValue: (data) => this.handleSecuritySystemTargetStateGet(),
      setValue: (value) => this.handleSecuritySystemTargetStateSet(value),
      onValue: (service, characteristic) => {
        // eslint-disable-next-line max-len
        this.device.on('guard mode', (station: Station, guardMode: number) => {
          this.onStationGuardModePushNotification(characteristic, station, guardMode);
        });
        this.device.on('alarm arm delay event', this.onStationAlarmDelayedEvent.bind(this));
        this.device.on('alarm armed event', this.onStationAlarmArmedEvent.bind(this));
      },
    });

    this.getService(this.platform.Service.SecuritySystem)
      .getCharacteristic(this.platform.Characteristic.SecuritySystemTargetState)
      .setProps({ validValues });

    this.registerCharacteristic({
      serviceType: this.platform.Service.Switch,
      characteristicType: this.platform.Characteristic.On,
      name: this.accessory.displayName + '_Siren',
      getValue: (data) => this.handleManualTriggerSwitchStateGet(),
      setValue: (value) => this.handleManualTriggerSwitchStateSet(value),
    });

    this.pruneUnusedServices();
  }

  /**
   * Get the current value of the "propertyName" characteristic
   */
  protected getPropertyValue(propertyName: PropertyName): PropertyValue {
    return this.device.getPropertyValue(propertyName);
  }

  protected async setPropertyValue(propertyName: PropertyName, value: unknown) {
    await this.platform.eufyClient.setStationProperty(this.SN, propertyName, value);
  }

  /**
   * Helper function to get a configuration value by checking custom, global, and default settings.
   * @param {number} customValue - Value from the custom configuration
   * @param {number} globalValue - Value from the global configuration
   * @param {number} defaultValue - The default value to use if both custom and global values are undefined
   * @returns {number} The chosen value based on priority
   */
  private getConfigValue(customValue: number | undefined, globalValue: number | undefined, defaultValue: number) {
    return customValue !== undefined ? customValue : (globalValue !== undefined ? globalValue : defaultValue);
  }

  /**
   * Gets the station configuration based on several possible sources.
   * Priority is given to custom configurations (if available), then falls back to global configs,
   * and lastly uses default values if neither custom nor global configs are set.
   *
   * @returns {StationConfig} The final configuration settings for the station
   */
  private getStationConfig() {
    // Find the station configuration based on the serial number, if it exists
    const stationConfig = this.platform.config.stations?.find((station) => station.serialNumber === this.SN);

    // Debug log to show the retrieved station configuration
    this.platform.log.debug(`${this.accessory.displayName} Config: ${JSON.stringify(stationConfig)}`);

    // Initialize the config object with prioritized values
    const config: StationConfig = {
      // For each setting (e.g., hkHome), check if it is defined in the custom config,
      // if not, check the global config, and as a last resort, use the default value
      hkHome: this.getConfigValue(stationConfig?.hkHome, this.platform.config.hkHome, 0),
      hkAway: this.getConfigValue(stationConfig?.hkAway, this.platform.config.hkAway, 1),
      hkNight: this.getConfigValue(stationConfig?.hkNight, this.platform.config.hkNight, 2),
      // Default HomeKit mode for 'Off':
      // - If a keypad is present, set to 63 (Special value)
      // - Otherwise, set to 6 (Default value)
      hkOff: this.getConfigValue(stationConfig?.hkOff, this.platform.config.hkOff, this.hasKeyPad ? 63 : 6),

      // Use optional chaining to safely access manualTriggerModes and manualAlarmSeconds
      manualTriggerModes: stationConfig?.manualTriggerModes ?? [],
      manualAlarmSeconds: stationConfig?.manualAlarmSeconds ?? 30,
    };

    // Log the manual trigger modes for debugging purposes
    this.platform.log.debug(`${this.accessory.displayName}
    manual alarm will be triggered only in these hk modes:
     ${config.manualTriggerModes}`);

    // Return the final configuration object
    return config;
  }


  private onStationGuardModePushNotification(
    characteristic: Characteristic,
    station: Station,
    guardMode: number,
  ): void {
    this.platform.log.debug(`${this.accessory.displayName} ON SecurityGuardMode: ${guardMode}`);
    const homekitCurrentMode = this.convertEufytoHK(guardMode);
    characteristic.updateValue(homekitCurrentMode);
  }

  private onStationCurrentModePushNotification(
    characteristic: Characteristic,
    station: Station,
    currentMode: number,
  ): void {
    if (this.guardModeChangeTimeout.timeout) {
      // If there's an existing timeout, clear it
      clearTimeout(this.guardModeChangeTimeout.timeout);
    }
    this.platform.log.debug(`${this.accessory.displayName} ON SecuritySystemCurrentState: ${currentMode}`);
    const homekitCurrentMode = this.convertEufytoHK(currentMode);
    characteristic.updateValue(homekitCurrentMode);
  }

  private onStationAlarmEventPushNotification(
    characteristic: Characteristic,
    station: Station,
    alarmEvent: AlarmEvent,
  ): void {
    let currentValue = this.device.getPropertyValue(PropertyName.StationCurrentMode);
    if (alarmEvent === 0) {
      // do not resset alarm if alarm was triggered manually
      // since the alarm can only be triggered for 30 seconds for now (limitation of eufy-security-client)
      // this would mean that the alarm is always reset after 30 seconds
      // see here: https://github.com/bropat/eufy-security-client/issues/178
      currentValue = -1;
    }
    switch (alarmEvent) {
      case 2: // Alarm triggered by GSENSOR
      case 3: // Alarm triggered by PIR
      case 4: // Alarm triggered by EUFY_APP
      case 6: // Alarm triggered by DOOR
      case 7: // Alarm triggered by CAMERA_PIR
      case 8: // Alarm triggered by MOTION_SENSOR
      case 9: // Alarm triggered by CAMERA_GSENSOR
        this.platform.log.warn('ON StationAlarmEvent - ALARM TRIGGERED - alarmEvent:', AlarmEvent[alarmEvent]);
        this.alarm_triggered = true;
        characteristic.updateValue(this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED); // Alarm !!!
        break;
      case 0:  // Alarm off by Hub
      case 15: // Alarm off by Keypad
      case 16: // Alarm off by Eufy App
      case 17: // Alarm off by HomeBase button
        this.platform.log.warn('ON StationAlarmEvent - ALARM OFF - alarmEvent:', AlarmEvent[alarmEvent]);
        this.alarm_triggered = false;
        if (currentValue !== -1) {
          characteristic.updateValue(this.convertEufytoHK(currentValue)); // reset alarm state
        }
        break;
      default:
        this.platform.log.warn('ON StationAlarmEvent - ALARM UNKNOWN - alarmEvent:', AlarmEvent[alarmEvent]);
        characteristic.updateValue(this.platform.Characteristic.StatusFault.GENERAL_FAULT);
        break;
    }

    this.updateManuelTriggerButton(this.alarm_triggered);
  }

  private mappingHKEufy(): void {
    // Initialize the modes array with HomeKit and Eufy mode mappings
    this.modes = [
      { hk: 0, eufy: this.stationConfig.hkHome },
      { hk: 1, eufy: this.stationConfig.hkAway },
      { hk: 2, eufy: this.stationConfig.hkNight },
      { hk: 3, eufy: this.stationConfig.hkOff },
    ];

    // Log the mapping for station modes for debugging purposes
    this.platform.log.debug(`${this.accessory.displayName} Mapping for station modes: ${JSON.stringify(this.modes)}`);
  }

  /**
   * Convert a HomeKit mode number to its corresponding Eufy mode number.
   * Searches the `this.modes` array to find a matching HomeKit mode.
   * Throws an error if a matching mode is not found.
   *
   * @param {number} hkMode - The HomeKit mode to convert
   * @returns {number} The corresponding Eufy mode
   * @throws {Error} If a matching mode is not found
   */
  convertHKtoEufy(hkMode: number): number {
    const modeObj = this.modes.find((m) => m.hk === hkMode);
    if (!modeObj) {
      throw new Error(`${this.accessory.displayName} No matching Eufy mode found for HomeKit mode ${hkMode}`);
    }
    return modeObj.eufy;
  }

  /**
   * Convert a Eufy mode number to its corresponding HomeKit mode number.
   * Searches the `this.modes` array to find a matching Eufy mode.
   * Throws an error if a matching mode is not found.
   *
   * @param {number} eufyMode - The Eufy mode to convert
   * @returns {number} The corresponding HomeKit mode
   * @throws {Error} If a matching mode is not found
   */
  convertEufytoHK(eufyMode: number): number {
    const modeObj = this.modes.find((m) => m.eufy === eufyMode);
    if (!modeObj) {
      throw new Error(`${this.accessory.displayName} No matching HomeKit mode found for Eufy mode ${eufyMode}`);
    }
    return modeObj.hk;
  }


  /**
   * Handle requests to get the current value of the 'Security System Current State' characteristic
   */
  protected handleSecuritySystemCurrentStateGet(): CharacteristicValue {
    if (this.alarm_triggered) {
      return this.platform.Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
    }
    return this.handleSecuritySystemTargetStateGet('handleSecuritySystemCurrentStateGets');
  }

  /**
   * Handle requests to get the current value of the 'Security System Target State' characteristic
   */
  private handleSecuritySystemTargetStateGet(stateCharacteristic: string = 'handleSecuritySystemTargetStateGet'): CharacteristicValue {
    try {
      const currentValue = this.device.getPropertyValue(PropertyName.StationCurrentMode);
      if (currentValue === -1) {
        throw 'Something wrong with this device';
      }
      this.platform.log.debug(`${this.accessory.displayName} GET StationCurrentMode: ${currentValue}`);
      return this.convertEufytoHK(currentValue);
    } catch {
      this.platform.log.error(`${this.accessory.displayName} ${stateCharacteristic}: Wrong return value`);
      return false;
    }
  }

  /**
   * Handle requests to set the 'Security System Target State' characteristic
   */
  private handleSecuritySystemTargetStateSet(value: CharacteristicValue) {
    try {
      this.alarm_triggered = false;
      const NameMode = this.getGuardModeName(value);
      this.platform.log.debug(`${this.accessory.displayName} SET StationGuardMode HomeKit: ${NameMode}`);
      const mode = this.convertHKtoEufy(value as number);

      if (isNaN(mode)) {
        throw new Error(`${this.accessory.displayName}:
        Could not convert guard mode value to valid number. Aborting guard mode change...'`);
      }

      this.platform.log.debug(`${this.accessory.displayName} SET StationGuardMode Eufy: ${GuardMode[mode]}(${mode})`);
      this.platform.log.info(`${this.accessory.displayName} Request to change station guard mode to: ${NameMode}`);

      // Call the device's setGuardMode method to initiate the action
      this.device.setGuardMode(mode);

      // Set a new timeout
      this.guardModeChangeTimeout.timeout = setTimeout(() => {
        // This code is executed when the timeout elapses, indicating that the action may not have completed yet.
        // You can include a message indicating that the action is being retried.
        this.platform.log.warn(`${this.accessory.displayName} Changing guard mode to ${NameMode} did not complete. Retry...'`);

        // Call the device's setGuardMode method to initiate the action
        this.device.setGuardMode(mode);

        // Set a secondary timeout for retry, if needed
        const retryTimeout = setTimeout(() => {
          // This code is executed if the retry also times out, indicating a failure.
          this.platform.log.error(`${this.accessory.displayName} Changing guard mode to ${NameMode} timed out!`);
        }, this.guardModeChangeTimeout.delay);

        // Store the retry timeout as part of guardModeChangeTimeout
        this.guardModeChangeTimeout.timeout = retryTimeout;
      }, this.guardModeChangeTimeout.delay);

      this.updateManuelTriggerButton(false);

    } catch (error) {
      this.platform.log.error(`${this.accessory.displayName} Error Setting security mode! ${error}`);
    }
  }

  private handleManualTriggerSwitchStateGet(): CharacteristicValue {
    return this.alarm_triggered;
  }

  private async handleManualTriggerSwitchStateSet(value: CharacteristicValue) {
    if (value) { // trigger alarm
      try {
        const currentValue = this.device.getPropertyValue(PropertyName.StationCurrentMode);
        if (currentValue === -1) {
          throw 'Something wrong with this device';
        }
        // check if alarm is allowed for this guard mode
        // and alarm is not delayed
        if (this.stationConfig.manualTriggerModes.indexOf(this.convertEufytoHK(currentValue)) !== -1 && !this.alarm_delayed) {
          this.device.triggerStationAlarmSound(this.stationConfig.manualAlarmSeconds)
            .then(() => this.platform.log.debug(
              this.accessory.displayName, 'alarm manually triggered for ' + this.stationConfig.manualAlarmSeconds + ' seconds.'))
            .catch(err => this.platform.log.error(`${this.accessory.displayName} alarm could not be manually triggered: ${err}`));
        } else {
          const message = this.alarm_delayed ?
            'tried to trigger alarm, but the alarm delayed event was triggered beforehand.' :
            'tried to trigger alarm, but the current station mode prevents the alarm from being triggered. ' +
            'Please look in in the configuration if you want to change this behaviour.';
          setTimeout(() => {
            this.platform.log.info(`${this.accessory.displayName} ${message}`);
            this.updateManuelTriggerButton(false);
          }, 1000);
        }
      } catch {
        this.platform.log.error(`${this.accessory.displayName} handleSecuritySystemTargetStateGet: ${value}`);
        return;
      }
    } else { // reset alarm
      this.device.resetStationAlarmSound()
        .then(() => this.platform.log.debug(`${this.accessory.displayName} alarm manually reset`))
        .catch(err => this.platform.log.error(`${this.accessory.displayName} alarm could not be reset: ${err}`));
    }
  }

  private onStationAlarmDelayedEvent(station: Station, armDelay: number) {
    this.platform.log.debug(`${this.accessory.displayName} alarm for this station will be delayed by ${armDelay} seconds.`);
    this.alarm_delayed = true;

    if (this.alarm_delay_timeout) {
      clearTimeout(this.alarm_delay_timeout);
    }

    this.alarm_delay_timeout = setTimeout(() => {
      this.platform.log.debug(`${this.accessory.displayName} alarm for this station is armed now (due to timeout).`);
      this.alarm_delayed = false;
    }, (armDelay + 1) * 1000);
  }

  private onStationAlarmArmedEvent(station: Station) {
    this.platform.log.debug(`${this.accessory.displayName} alarm for this station is armed now.`);
    this.alarm_delayed = false;

    if (this.alarm_delay_timeout) {
      clearTimeout(this.alarm_delay_timeout);
    }
  }

  private getGuardModeName(value: CharacteristicValue): string {
    try {
      return `${HKGuardMode[value as number]}(${value})`;
    } catch (error) {
      return 'Unknown';
    }
  }

  private updateManuelTriggerButton(state: boolean) {
    this.getService(this.platform.Service.Switch, this.accessory.displayName + '_Siren')
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(state);
  }

}
