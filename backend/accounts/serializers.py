from django.contrib.auth import get_user_model, password_validation
from django.core.exceptions import ValidationError
from rest_framework import serializers


class UserSerializer(serializers.ModelSerializer):
    google_connected = serializers.SerializerMethodField()
    has_password = serializers.BooleanField(source='has_usable_password', read_only=True)

    def get_google_connected(self, obj):
        return hasattr(obj, 'google_identity')

    class Meta:
        model = get_user_model()
        fields = ['id', 'username', 'google_connected', 'has_password']
        read_only_fields = fields


class RegisterSerializer(serializers.ModelSerializer):
    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)
    confirm_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)

    class Meta:
        model = get_user_model()
        fields = ['username', 'email', 'password', 'confirm_password']

    def validate_email(self, value):
        value = value.strip().lower()
        if get_user_model().objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError('An account with this email already exists. Sign in instead.')
        return value

    def validate(self, attrs):
        if attrs['password'] != attrs['confirm_password']:
            raise serializers.ValidationError({'confirm_password': 'Passwords do not match.'})
        user = get_user_model()(username=attrs['username'], email=attrs['email'])
        try:
            password_validation.validate_password(attrs['password'], user)
        except ValidationError as exc:
            raise serializers.ValidationError({'password': exc.messages})
        return attrs

    def create(self, validated_data):
        validated_data.pop('confirm_password')
        return get_user_model().objects.create_user(**validated_data)


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)


class ResendVerificationSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)


class VerifyEmailSerializer(serializers.Serializer):
    token = serializers.CharField(max_length=128, trim_whitespace=False)
