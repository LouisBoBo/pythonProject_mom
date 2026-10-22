def test_published_sdk_exposes_harness() -> None:
    from deepseek_harness import DeepSeekHarness

    assert callable(DeepSeekHarness)
