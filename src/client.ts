import axios, { AxiosInstance } from "axios";

export interface CreateInstancePayload {
  instanceName: string;
  /** Baileys: apikey opcional da instância. Business: token permanente da Meta Cloud API (obrigatório). */
  token?: string;
  /** Baileys: número opcional. Business: phone number ID da Meta (obrigatório). */
  number?: string;
  qrcode?: boolean;
  integration?: "WHATSAPP-BAILEYS" | "WHATSAPP-BUSINESS";
  /** WhatsApp Business Account ID (WABA) — obrigatório para WHATSAPP-BUSINESS. */
  businessId?: string;
}

export interface SendTextPayload {
  number: string;
  text: string;
  options?: {
    delay?: number;
    presence?: "composing" | "recording" | "paused";
    linkPreview?: boolean;
  };
}

export interface SendMediaPayload {
  number: string;
  mediaMessage: {
    mediatype: "image" | "video" | "audio" | "document";
    media: string; // URL or Base64 string
    caption?: string;
    fileName?: string;
  };
  options?: {
    delay?: number;
    presence?: "composing" | "recording" | "paused";
  };
}

export interface ConfigureTypebotPayload {
  enabled: boolean;
  url: string;
  typebot: string;
  expire?: number;
  keywordFinish?: string;
  delayMessage?: number;
  unknownMessage?: string;
  listeningFromMe?: boolean;
  stopBotFromMe?: boolean;
  keepOpen?: boolean;
  debounceTime?: number;
  /** Gatilho do fluxo (Evolution v2 suporta vários bots por instância). */
  triggerType?: "keyword" | "all" | "none" | "advanced";
  triggerOperator?: "contains" | "equals" | "startsWith" | "endsWith" | "regex";
  triggerValue?: string;
}

export interface TypebotChangeStatusPayload {
  remoteJid: string;
  status: "opened" | "paused" | "closed";
}

export interface TypebotStartPayload {
  url: string;
  typebot: string;
  remoteJid: string;
  startSession?: boolean;
  variables?: Array<{ name: string; value: string }>;
}

export interface ConfigureWebhookPayload {
  enabled: boolean;
  url: string;
  events: string[];
}

export interface FetchMessagesPayload {
  /** Filter to a single chat. Sent to Evolution as where.key.remoteJid. */
  remoteJid?: string;
  /** 1-based page number. */
  page?: number;
  /** Messages per page (Evolution's `offset`). */
  pageSize?: number;
}

export class EvolutionClient {
  private axiosInstance: AxiosInstance;

  constructor(apiUrl: string, globalKey: string) {
    // Ensure API URL has no trailing slash
    const baseURL = apiUrl.replace(/\/+$/, "");
    this.axiosInstance = axios.create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
        "apikey": globalKey,
      },
    });
  }

  // --- INSTANCE MANAGEMENT ---

  async listInstances() {
    try {
      const response = await this.axiosInstance.get("/instance/fetchInstances");
      return response.data;
    } catch (error: any) {
      this.handleError("listInstances", error);
    }
  }

  async createInstance(payload: CreateInstancePayload) {
    try {
      const response = await this.axiosInstance.post("/instance/create", payload);
      return response.data;
    } catch (error: any) {
      this.handleError("createInstance", error);
    }
  }

  async deleteInstance(instanceName: string) {
    try {
      const response = await this.axiosInstance.delete(`/instance/delete/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("deleteInstance", error);
    }
  }

  async logoutInstance(instanceName: string) {
    try {
      const response = await this.axiosInstance.post(`/instance/logout/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("logoutInstance", error);
    }
  }

  async connectInstance(instanceName: string) {
    try {
      const response = await this.axiosInstance.get(`/instance/connect/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("connectInstance", error);
    }
  }

  async getInstanceStatus(instanceName: string) {
    try {
      const response = await this.axiosInstance.get(`/instance/connectionStatus/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("getInstanceStatus", error);
    }
  }

  // --- MESSAGING ---

  async sendText(instanceName: string, payload: SendTextPayload) {
    try {
      const response = await this.axiosInstance.post(`/message/sendText/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("sendText", error);
    }
  }

  async sendMedia(instanceName: string, payload: SendMediaPayload) {
    try {
      const response = await this.axiosInstance.post(`/message/sendMedia/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("sendMedia", error);
    }
  }

  async getMessages(instanceName: string, payload: FetchMessagesPayload = {}) {
    try {
      // Evolution API v2: POST /chat/findMessages/:instance, response shape
      // { messages: { total, pages, currentPage, records } }.
      const body: Record<string, any> = {
        // `page` is the 1-based page number; `offset` is the page size
        // (records per page). Default to a small page so triage calls don't
        // pull the entire ~50-message global window on every request.
        page: payload.page ?? 1,
        offset: payload.pageSize ?? 20,
      };
      // The filter must be nested under where.key, mirroring the Baileys
      // message key shape ({ key: { remoteJid, fromMe, id } }) that each
      // record carries. A flat { where: { remoteJid } } is silently ignored.
      if (payload.remoteJid) {
        body.where = { key: { remoteJid: payload.remoteJid } };
      }
      const response = await this.axiosInstance.post(`/chat/findMessages/${instanceName}`, body);
      return response.data;
    } catch (error: any) {
      this.handleError("getMessages", error);
    }
  }

  // --- TYPEBOT INTEGRATION ---

  async configureTypebot(instanceName: string, payload: ConfigureTypebotPayload) {
    try {
      // In Evolution API v2, configuring typebot is POST to /typebot/create/:instance
      const response = await this.axiosInstance.post(`/typebot/create/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("configureTypebot", error);
    }
  }

  async getTypebotSettings(instanceName: string) {
    try {
      const response = await this.axiosInstance.get(`/typebot/fetchSettings/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("getTypebotSettings", error);
    }
  }

  /** Lista os fluxos (typebots) vinculados à instância — v2 suporta vários, com gatilhos. */
  async listTypebots(instanceName: string) {
    try {
      const response = await this.axiosInstance.get(`/typebot/find/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("listTypebots", error);
    }
  }

  async updateTypebot(instanceName: string, typebotId: string, payload: ConfigureTypebotPayload) {
    try {
      const response = await this.axiosInstance.put(`/typebot/update/${typebotId}/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("updateTypebot", error);
    }
  }

  async deleteTypebot(instanceName: string, typebotId: string) {
    try {
      const response = await this.axiosInstance.delete(`/typebot/delete/${typebotId}/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("deleteTypebot", error);
    }
  }

  /** Sessões de conversa em andamento com um fluxo específico. */
  async fetchTypebotSessions(instanceName: string, typebotId: string) {
    try {
      const response = await this.axiosInstance.get(`/typebot/fetchSessions/${typebotId}/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("fetchTypebotSessions", error);
    }
  }

  /** Defaults da instância (expire, keywordFinish, delayMessage etc). */
  async setTypebotDefaults(instanceName: string, payload: Omit<ConfigureTypebotPayload, "url" | "typebot" | "triggerType" | "triggerOperator" | "triggerValue">) {
    try {
      const response = await this.axiosInstance.post(`/typebot/settings/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("setTypebotDefaults", error);
    }
  }

  async changeTypebotStatus(instanceName: string, payload: TypebotChangeStatusPayload) {
    try {
      const response = await this.axiosInstance.post(`/typebot/changeStatus/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("changeTypebotStatus", error);
    }
  }

  async startTypebotFlow(instanceName: string, payload: TypebotStartPayload) {
    try {
      const response = await this.axiosInstance.post(`/typebot/start/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("startTypebotFlow", error);
    }
  }

  // --- WEBHOOKS ---

  async configureWebhook(instanceName: string, payload: ConfigureWebhookPayload) {
    try {
      const response = await this.axiosInstance.post(`/webhook/set/${instanceName}`, payload);
      return response.data;
    } catch (error: any) {
      this.handleError("configureWebhook", error);
    }
  }

  async getWebhookSettings(instanceName: string) {
    try {
      const response = await this.axiosInstance.get(`/webhook/find/${instanceName}`);
      return response.data;
    } catch (error: any) {
      this.handleError("getWebhookSettings", error);
    }
  }

  // --- ERROR HANDLING ---

  private handleError(action: string, error: any) {
    const status = error.response?.status;
    const details = error.response?.data;
    const message = error.message;

    console.error(`Error in EvolutionClient.${action}:`, {
      status,
      details,
      message,
    });

    let errMsg = `Evolution API error during ${action}: ${message}`;
    if (details) {
      errMsg += ` - Details: ${JSON.stringify(details)}`;
    }
    throw new Error(errMsg);
  }
}
