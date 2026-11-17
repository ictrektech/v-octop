import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Input,
  Modal,
  Space,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";
import LazyMarkdown from "../../../components/Markdown/LazyMarkdown";
import apiEn from "./vos-ops.en.md?raw";
import apiZh from "./vos-ops.zh.md?raw";

type Action =
  | "restart"
  | "stop-container"
  | "remove-container"
  | "remove-image";
interface Grant {
  key: string;
  expiresAt: number;
}
interface Preview {
  action: Action;
  targetId: string;
  target: object;
  confirmation: string;
}
interface Inventory {
  apps: {
    appId: string;
    version: string;
    state: string;
    lastError: string;
    restartable: boolean;
  }[];
  containers: {
    id: string;
    name: string;
    status: string;
    stoppable: boolean;
    cleanup: boolean;
    stack: { version: string };
  }[];
  publishedPorts: {
    hostPort: number;
    containerPort: number;
    protocol: string;
    address: string;
    container: string;
  }[];
  unusedImages: { id: string; bytes: number }[];
  unreferencedTaggedImages: { id: string; tags: string[]; bytes: number }[];
}

// Keep authorization available when navigating to an expert. A reload clears browser memory.
let savedGrant: Grant | undefined;

async function request<T>(
  path: string,
  grant?: Grant,
  body?: object,
): Promise<T> {
  const response = await fetch(
    `${import.meta.env.BASE_URL}__va/vos-ops/${path}`,
    {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "x-va-ops": "1",
        ...(grant ? { "x-va-ops-grant": grant.key } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

const outputStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 320,
  overflow: "auto",
} as const;

export default function VosOpsPanel() {
  const { t, i18n } = useTranslation();
  const label = (key: string) => t(`vosOps.${key}`);
  const [grant, setGrant] = useState(savedGrant);
  const [expert, setExpert] = useState(false);
  const [inventory, setInventory] = useState<Inventory>();
  const [details, setDetails] = useState<{ title: string; text: string }>();
  const [preview, setPreview] = useState<Preview>();
  const [targetId, setTargetId] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    key: string;
    taskId?: string;
    error?: boolean;
  }>();

  const updateGrant = (next?: Grant) => {
    savedGrant = next;
    setGrant(next);
  };

  useEffect(() => {
    if (!grant) return;
    const timer = setTimeout(
      () => {
        if (savedGrant === grant) savedGrant = undefined;
        setGrant(undefined);
        setFeedback({ key: "expired", error: true });
      },
      Math.max(0, grant.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [grant]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setFeedback(undefined);
    try {
      await operation();
    } catch (error) {
      const status = error instanceof Error ? error.message : "";
      if (status === "401" || status === "403") {
        updateGrant(undefined);
        setInventory(undefined);
        setDetails(undefined);
        setPreview(undefined);
      }
      setFeedback({
        error: true,
        key:
          status === "401" || status === "403"
            ? "forbidden"
            : status === "409"
            ? "changed"
            : "failed",
      });
    } finally {
      setBusy(false);
    }
  }

  function authorize() {
    return run(async () => {
      const data = await request<{ grant: string; expiresIn: number }>(
        "authorize",
        undefined,
        { expert },
      );
      const next = {
        key: data.grant,
        expiresAt: Date.now() + data.expiresIn * 1000,
      };
      updateGrant(next);
      setInventory(undefined);
      setInventory(await request<Inventory>("inventory", next));
    });
  }

  function prepare(action: Action, id: string) {
    return run(async () => {
      setTargetId("");
      setPreview(await request<Preview>("preview", grant, { action, id }));
    });
  }

  function inspect(path: string, title: string) {
    return run(async () => {
      const result = await request<{ text?: string }>(path, grant);
      setDetails({
        title,
        text: result.text ?? JSON.stringify(result, null, 2),
      });
    });
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph>{label("intro")}</Typography.Paragraph>
      {grant ? (
        <Space wrap>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setInventory(await request<Inventory>("inventory", grant));
              })
            }
          >
            {label("refresh")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await request("close", grant, {});
                updateGrant(undefined);
                setInventory(undefined);
                setDetails(undefined);
                setPreview(undefined);
              })
            }
          >
            {label("close")}
          </Button>
        </Space>
      ) : (
        <Space wrap>
          <Checkbox
            checked={expert}
            onChange={(event) => setExpert(event.target.checked)}
          >
            {label("expert")}
          </Checkbox>
          <Button
            type="primary"
            loading={busy}
            onClick={() => void authorize()}
          >
            {label("authorize")}
          </Button>
        </Space>
      )}
      {feedback && (
        <Alert
          showIcon
          type={feedback.error ? "error" : "success"}
          message={
            <>
              {label(feedback.key)}{" "}
              {feedback.taskId && <code>{feedback.taskId}</code>}
            </>
          }
        />
      )}
      <Collapse
        items={[
          {
            key: "api",
            label: label("api"),
            children: (
              <LazyMarkdown
                content={i18n.language.startsWith("zh") ? apiZh : apiEn}
              />
            ),
          },
        ]}
      />
      {grant && inventory && (
        <>
          <Typography.Title level={4}>{label("apps")}</Typography.Title>
          {inventory.apps.map((app) => (
            <div key={app.appId}>
              <Space wrap>
                <strong>{app.appId}</strong> {app.version} · {app.state}
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void inspect(
                      `status?id=${encodeURIComponent(app.appId)}`,
                      app.appId,
                    )
                  }
                >
                  {label("status")}
                </Button>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void inspect(
                      `app-logs?appId=${encodeURIComponent(app.appId)}`,
                      app.appId,
                    )
                  }
                >
                  {label("logs")}
                </Button>
                {app.restartable && (
                  <Button
                    size="small"
                    danger
                    disabled={busy}
                    onClick={() => void prepare("restart", app.appId)}
                  >
                    {label("restart")}
                  </Button>
                )}
              </Space>
              {app.lastError && <pre style={outputStyle}>{app.lastError}</pre>}
            </div>
          ))}
          <Typography.Title level={4}>{label("containers")}</Typography.Title>
          {inventory.containers.map((container) => (
            <Space key={container.id} wrap>
              <strong>{container.name}</strong> {container.stack.version} ·{" "}
              {container.status}
              <Button
                size="small"
                disabled={busy}
                onClick={() =>
                  void inspect(`diagnose?id=${container.id}`, container.name)
                }
              >
                {label("diagnose")}
              </Button>
              <Button
                size="small"
                disabled={busy}
                onClick={() =>
                  void inspect(`logs?id=${container.id}`, container.name)
                }
              >
                {label("logs")}
              </Button>
              {container.stoppable && (
                <Button
                  size="small"
                  danger
                  disabled={busy}
                  onClick={() => void prepare("stop-container", container.id)}
                >
                  {label("stop-container")}
                </Button>
              )}
              {container.cleanup && (
                <Button
                  size="small"
                  danger
                  disabled={busy}
                  onClick={() => void prepare("remove-container", container.id)}
                >
                  {label("remove-container")}
                </Button>
              )}
            </Space>
          ))}
          <Typography.Title level={4}>{label("ports")}</Typography.Title>
          <Input.Search
            placeholder={label("port")}
            aria-label={label("port")}
            value={port}
            inputMode="numeric"
            onChange={(event) => setPort(event.target.value)}
          />
          <ul>
            {inventory.publishedPorts
              .filter(
                (row) => !port.trim() || String(row.hostPort) === port.trim(),
              )
              .map((row, index) => (
                <li key={index}>
                  <code>
                    {row.address}:{row.hostPort}/{row.protocol}
                  </code>{" "}
                  → {row.container}:{row.containerPort}
                </li>
              ))}
          </ul>
          <Typography.Title level={4}>{label("unused")}</Typography.Title>
          <Typography.Paragraph>{label("layers")}</Typography.Paragraph>
          {inventory.unusedImages.map((image) => (
            <Space key={image.id} wrap>
              <code style={{ overflowWrap: "anywhere" }}>{image.id}</code>{" "}
              {(image.bytes / 1048576).toFixed(1)} MiB
              <Button
                size="small"
                danger
                disabled={busy}
                onClick={() => void prepare("remove-image", image.id)}
              >
                {label("remove-image")}
              </Button>
            </Space>
          ))}
          <Typography.Title level={4}>{label("tagged")}</Typography.Title>
          {inventory.unreferencedTaggedImages.map((image) => (
            <div key={image.id}>
              {image.tags.join(", ")} · {(image.bytes / 1048576).toFixed(1)} MiB
            </div>
          ))}
        </>
      )}
      <Modal
        open={Boolean(grant && details)}
        title={details?.title}
        footer={null}
        onCancel={() => setDetails(undefined)}
      >
        <pre style={outputStyle}>{details?.text}</pre>
      </Modal>
      <Modal
        open={Boolean(grant && preview)}
        title={preview && label(preview.action)}
        okText={label("confirm")}
        cancelText={t("common.cancel")}
        okButtonProps={{
          danger: true,
          disabled: !preview || targetId !== preview.targetId,
          loading: busy,
        }}
        onCancel={() => setPreview(undefined)}
        onOk={() => {
          if (!preview || targetId !== preview.targetId) return;
          setPreview(undefined);
          void run(async () => {
            const result = await request<{ taskId: string | null }>(
              "execute",
              grant,
              {
                confirmation: preview.confirmation,
                targetId,
              },
            );
            setFeedback({
              key: "accepted",
              taskId: result.taskId ?? undefined,
            });
          });
        }}
      >
        <Typography.Paragraph>{label("exactTarget")}</Typography.Paragraph>
        <pre style={outputStyle}>
          {JSON.stringify(preview?.target, null, 2)}
        </pre>
        <Input
          value={targetId}
          aria-label={label("targetId")}
          placeholder={label("targetId")}
          onChange={(event) => setTargetId(event.target.value)}
        />
      </Modal>
    </Space>
  );
}
