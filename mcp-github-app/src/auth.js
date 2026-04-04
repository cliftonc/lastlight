import { readFileSync } from "fs";
import { resolve } from "path";
import jwt from "jsonwebtoken";

export class GitHubAppAuth {
  constructor({ appId, privateKeyPath, installationId }) {
    this.appId = appId;
    this.installationId = installationId;
    this.privateKey = readFileSync(resolve(privateKeyPath), "utf8");
    this._token = null;
    this._expiresAt = null;
  }

  _generateJWT() {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: now - 60, exp: now + 600, iss: this.appId },
      this.privateKey,
      { algorithm: "RS256" }
    );
  }

  async getToken() {
    // Return cached token if still valid (5-min buffer)
    if (this._token && this._expiresAt) {
      const bufferMs = 5 * 60 * 1000;
      if (Date.now() + bufferMs < this._expiresAt.getTime()) {
        return this._token;
      }
    }

    const jwtToken = this._generateJWT();
    const res = await fetch(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get installation token (${res.status}): ${body}`);
    }

    const data = await res.json();
    this._token = data.token;
    this._expiresAt = new Date(data.expires_at);
    return this._token;
  }

  async getAuthHeaders() {
    const token = await this.getToken();
    return {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    };
  }

  get expiresAt() {
    return this._expiresAt;
  }
}
