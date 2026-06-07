from __future__ import annotations


class TokendanceModelError(RuntimeError):
    """Base class for provider-neutral model errors."""


class RateLimited(TokendanceModelError):
    pass


class AuthFailed(TokendanceModelError):
    pass


class ModelNotFound(TokendanceModelError):
    pass


class ContextLengthExceeded(TokendanceModelError):
    pass


class ProviderUnavailable(TokendanceModelError):
    pass


class BadRequest(TokendanceModelError):
    pass


class UnknownProviderError(TokendanceModelError):
    pass


def normalize_provider_error(error: Exception) -> TokendanceModelError:
    status_code = getattr(error, "status_code", None)
    name = error.__class__.__name__.lower()
    message = str(error)
    lowered = message.lower()

    if status_code in {401, 403} or "auth" in name:
        return AuthFailed(message)
    if status_code == 429 or "rate" in name:
        return RateLimited(message)
    if status_code == 404 or "notfound" in name or "not_found" in name:
        return ModelNotFound(message)
    if status_code == 400 and ("context" in lowered or "token" in lowered):
        return ContextLengthExceeded(message)
    if status_code is not None and 500 <= int(status_code) <= 599:
        return ProviderUnavailable(message)
    if status_code == 400:
        return BadRequest(message)
    return UnknownProviderError(message)
