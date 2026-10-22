"""Run one agent task through the embedded DeepSeek Harness."""

from dsh_mom.agent import DshAgent
from dsh_mom.config import load_settings


def main() -> None:
    agent = DshAgent(load_settings())
    result = agent.run("检查仓库并修复失败的测试", session_id="my-task-001")
    print(result.final_response)


if __name__ == "__main__":
    main()
