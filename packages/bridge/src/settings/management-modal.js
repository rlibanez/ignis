import {Modal, setIcon} from "obsidian";
import {createManagementModal} from "../../../management/src/management-modal.js";
export const ManagementModal=createManagementModal(Modal, setIcon);
