import {Modal, Notice, setIcon} from "obsidian";
import {ManagementModal} from "./management-modal.js";
import {createAccountSettings} from "../../../management/src/account-settings.js";
export const {settingDefinitions}=createAccountSettings({Modal, Notice, setIcon, ManagementModal});
