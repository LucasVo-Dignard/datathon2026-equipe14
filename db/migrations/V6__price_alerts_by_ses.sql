-- Price alerts are sent with Amazon SES instead of SNS: the app and the job
-- email the address directly, so there is no SNS subscription any more.
--
-- unsubscribe_token: secret of the one-click unsubscribe link in every email
-- (GET /desabonnement?u=<username>&t=<token>, no login needed). Random, 122
-- bits, regenerated on each new subscription.

ALTER TABLE notification_subscriptions
    DROP COLUMN subscription_arn,
    ADD COLUMN unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid();
