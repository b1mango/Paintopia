import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../src/lib/apiClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiClient", () => {
  it("does not send JSON content type for bodyless actions", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "invite-1",
      code: "ABC123456789",
      status: "active",
      createdByEmail: "owner",
      usedByEmail: null,
      createdAt: "2026-06-15T00:00:00.000Z",
      usedAt: null,
      destroyedAt: null
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchImpl);

    await apiClient.createInviteCode();

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/invite-codes", expect.objectContaining({
      method: "POST",
      headers: {}
    }));
  });

  it("unsyncs gallery links with a bodyless DELETE", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ expiresAt: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    expect(await apiClient.unsyncAssetFromGallery("asset 1")).toEqual({ expiresAt: null });

    expect(fetchImpl).toHaveBeenCalledWith("/api/assets/asset%201/gallery", expect.objectContaining({
      method: "DELETE",
      headers: {}
    }));
  });

  it("loads generation stats from user and admin endpoints", async () => {
    const stats = {
      total: 3,
      completed: 3,
      succeeded: 2,
      failed: 1,
      running: 0,
      queued: 0,
      successRate: 66.7,
      averageDurationMs: 3000
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(stats), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await apiClient.getGenerationStats();
    await apiClient.getAdminGenerationStats();

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/generation-stats", expect.objectContaining({
      credentials: "include"
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/admin/generation-stats", expect.objectContaining({
      credentials: "include"
    }));
  });

  it("tests provider connectivity from admin settings", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      status: "connected",
      latencyMs: 123,
      totalTokens: 4,
      message: "OK"
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await apiClient.testProvider({
      kind: "text",
      name: "Translation",
      baseUrl: "https://text.example",
      apiKey: "test-key",
      model: "qwen",
      mode: "chat_completions",
      prompt: "ping"
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/providers/test", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        kind: "text",
        name: "Translation",
        baseUrl: "https://text.example",
        apiKey: "test-key",
        model: "qwen",
        mode: "chat_completions",
        prompt: "ping"
      })
    }));
  });

  it("loads provider model ids from admin settings", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      models: ["gpt-image-2", "custom-image-model"]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await apiClient.listProviderModels({
      baseUrl: "https://image.example",
      apiKey: "secret"
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/providers/models", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        baseUrl: "https://image.example",
        apiKey: "secret"
      })
    }));
  });

  it("updates provider configuration from admin settings", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "provider-1",
      kind: "image",
      name: "Primary Image",
      baseUrl: "https://image.example",
      apiKey: "********",
      model: "gpt-image-2",
      mode: "generations"
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await apiClient.updateProvider("provider-1", {
      kind: "image",
      name: "Primary Image",
      baseUrl: "https://image.example",
      apiKey: "secret",
      model: "gpt-image-2",
      mode: "generations",
      enabled: true
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/providers/provider-1", expect.objectContaining({
      method: "PATCH",
      credentials: "include",
      body: JSON.stringify({
        kind: "image",
        name: "Primary Image",
        baseUrl: "https://image.example",
        apiKey: "secret",
        model: "gpt-image-2",
        mode: "generations",
        enabled: true
      })
    }));
  });

  it("lists saved provider configurations from admin settings", async () => {
    const providers = [{
      id: "gpt-5-nano",
      kind: "text",
      name: "Saved GPT-5 Nano",
      baseUrl: "https://text.example",
      apiKey: "********",
      model: "gpt-5-nano",
      mode: "chat_completions"
    }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(providers), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiClient.listProviders()).resolves.toEqual(providers);

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/providers", expect.objectContaining({
      credentials: "include"
    }));
  });

  it("persists provider order from admin settings", async () => {
    const providers = [
      {
        id: "provider-b",
        kind: "text",
        name: "Provider B",
        baseUrl: "https://b.example",
        apiKey: "********",
        model: "b",
        mode: "chat_completions"
      },
      {
        id: "provider-a",
        kind: "text",
        name: "Provider A",
        baseUrl: "https://a.example",
        apiKey: "********",
        model: "a",
        mode: "chat_completions"
      }
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(providers), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiClient.reorderProviders("text", ["provider-b", "provider-a"])).resolves.toEqual(providers);

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/providers/order", expect.objectContaining({
      method: "PATCH",
      credentials: "include",
      body: JSON.stringify({
        kind: "text",
        providerIds: ["provider-b", "provider-a"]
      })
    }));
  });

  it("loads and updates quota pricing rules", async () => {
    const rules = [{ key: "quality.high", label: "high", amount: 3 }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(rules), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    await apiClient.listQuotaPricing();
    await apiClient.updateQuotaPricing([{ key: "quality.high", amount: 4 }]);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/quota-pricing", expect.objectContaining({
      credentials: "include"
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/admin/quota-pricing", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ rules: [{ key: "quality.high", amount: 4 }] })
    }));
  });

  it("parses chunked generation preview and completion events", async () => {
    const encoder = new TextEncoder();
    const completed = {
      type: "completed",
      result: {
        jobId: "job-stream",
        remainingQuota: 97,
        assets: [{
          id: "asset-stream",
          imageUrl: "/api/assets/asset-stream/original",
          prompt: "stream prompt",
          createdAt: "2026-08-03T00:00:00.000Z"
        }]
      }
    };
    const payload = [
      JSON.stringify({ type: "stage", stage: "waiting", message: "等待最终图片" }),
      JSON.stringify({ type: "preview", b64Json: "cHJldmlldw==", mimeType: "image/png", partialImageIndex: 0 }),
      JSON.stringify(completed),
      ""
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        const midpoint = Math.floor(payload.length / 2);
        controller.enqueue(encoder.encode(payload.slice(0, midpoint)));
        controller.enqueue(encoder.encode(payload.slice(midpoint)));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } }));
    vi.stubGlobal("fetch", fetchImpl);
    const onPreview = vi.fn();
    const onStage = vi.fn();

    const result = await apiClient.generateStream({
      prompt: "stream prompt",
      params: { quality: "low" }
    }, onPreview, onStage);
    expect(onStage).toHaveBeenCalledWith({ type: "stage", stage: "waiting", message: "等待最终图片" });

    expect(onPreview).toHaveBeenCalledWith({
      imageUrl: "data:image/png;base64,cHJldmlldw==",
      partialImageIndex: 0
    });
    expect(result).toEqual(completed.result);
    expect(fetchImpl).toHaveBeenCalledWith("/api/generate/stream", expect.objectContaining({
      method: "POST",
      credentials: "include"
    }));
  });

  it("uploads edit references first and sends only asset ids to generation", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/assets/uploads") {
        return new Response(JSON.stringify({
          assetId: "uploaded-asset",
          uploadUrl: "https://r2.example/upload",
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          expiresAt: "2026-08-11T00:00:00.000Z"
        }), { status: 201 });
      }
      if (url === "https://r2.example/upload") {
        return new Response(null, { status: 204 });
      }
      if (url === "/api/assets/uploaded-asset/complete-upload") {
        return new Response(JSON.stringify({
          id: "uploaded-asset",
          imageUrl: "/api/assets/uploaded-asset/original",
          prompt: "keep identity and change background",
          createdAt: "2026-08-04T00:00:00.000Z"
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jobId: "job-edit",
        assets: []
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const image = new File([new Uint8Array([1, 2, 3])], "reference.png", { type: "image/png" });

    await apiClient.generateEdit({
      prompt: "keep identity and change background",
      params: {
        size: "1024x1536",
        quality: "medium",
        n: 2
      },
      images: [image],
      assetIds: ["asset-1"]
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://r2.example/upload", expect.objectContaining({
      method: "PUT",
      credentials: "omit",
      headers: { "Content-Type": "image/png" },
      body: image
    }));
    expect(fetchImpl).toHaveBeenCalledWith("/api/generate/edit", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: expect.any(String)
    }));
    const generationCall = fetchImpl.mock.calls.find(([input]) => String(input) === "/api/generate/edit");
    const generationBody = JSON.parse(String(generationCall?.[1]?.body));
    expect(generationBody).toEqual({
      prompt: "keep identity and change background",
      params: {
        size: "1024x1536",
        quality: "medium",
        n: 2,
        clientRequestId: expect.any(String)
      },
      assetIds: ["asset-1"],
      transientAssetIds: ["uploaded-asset"]
    });
  });

  it("recovers completed image edits after the generation response disconnects", async () => {
    let clientRequestId = "";
    const recoveredAsset = {
      id: "asset-recovered",
      imageUrl: "/api/assets/asset-recovered/original",
      prompt: "recover this edit",
      params: {},
      createdAt: "2026-08-28T12:28:39.793Z"
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/generate/edit") {
        const body = JSON.parse(String(init?.body));
        clientRequestId = body.params.clientRequestId;
        throw new TypeError("Failed to fetch");
      }
      if (url === "/api/assets") {
        return new Response(JSON.stringify([{
          ...recoveredAsset,
          params: { clientRequestId, mode: "image-edit" }
        }]), { status: 200 });
      }
      if (url === "/api/auth/me") {
        return new Response(JSON.stringify({
          email: "artist@paintopia.local",
          role: "user",
          quota: 97
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const onRecovering = vi.fn();
    const result = await apiClient.generateEdit({
      prompt: "recover this edit",
      params: { model: "gpt-image-2", resolution: "1K", quality: "high", n: 1 },
      assetIds: ["source-asset"]
    }, onRecovering);

    expect(clientRequestId).not.toBe("");
    expect(onRecovering).toHaveBeenCalledOnce();
    expect(result).toEqual({
      assets: [{
        ...recoveredAsset,
        params: { clientRequestId, mode: "image-edit" }
      }],
      remainingQuota: 97,
      recovered: true
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/assets", expect.objectContaining({
      credentials: "include"
    }));
  });

  it("does not poll assets for an image edit HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: "provider rejected the edit"
    }), { status: 502 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiClient.generateEdit({
      prompt: "failed edit",
      params: { resolution: "1K" },
      assetIds: ["source-asset"]
    })).rejects.toThrow("provider rejected the edit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers image edits after a non-JSON gateway timeout", async () => {
    let clientRequestId = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/generate/edit") {
        clientRequestId = JSON.parse(String(init?.body)).params.clientRequestId;
        return new Response("Gateway Timeout", {
          status: 504,
          headers: { "Content-Type": "text/html" }
        });
      }
      if (url === "/api/assets") {
        return new Response(JSON.stringify([{
          id: "gateway-recovered",
          imageUrl: "/api/assets/gateway-recovered/original",
          prompt: "gateway recovery",
          params: { clientRequestId },
          createdAt: "2026-08-28T12:28:39.793Z"
        }]), { status: 200 });
      }
      if (url === "/api/auth/me") {
        return new Response(JSON.stringify({
          email: "artist@paintopia.local",
          role: "user",
          quota: 96
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiClient.generateEdit({
      prompt: "gateway recovery",
      params: { resolution: "1K" },
      assetIds: ["source-asset"]
    })).resolves.toMatchObject({
      recovered: true,
      remainingQuota: 96,
      assets: [expect.objectContaining({ id: "gateway-recovered" })]
    });
  });

  it("reports reference upload network failures without starting recovery polling", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchImpl);
    const image = new File([new Uint8Array([1, 2, 3])], "reference.png", { type: "image/png" });

    await expect(apiClient.generateEdit({
      prompt: "upload failure",
      params: { resolution: "1K" },
      images: [image]
    })).rejects.toThrow("参考图上传连接失败，请检查网络后重试");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalledWith("/api/assets", expect.anything());
  });
});
